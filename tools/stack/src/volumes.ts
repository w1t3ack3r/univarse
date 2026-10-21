// Spec 0019: the configuration-and-key volumes (compose `external`), filled with exactly what each service reads,
// owned by that service's user, keys 0600. A short-lived tool container (the pinned PostgreSQL image, as root, no
// network) copies from STACK_DIR, read-only; it never prints a file. Each volume is emptied first, so nothing stale
// survives a rotation.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { STACK_DIR, THIRD_PARTY } from './config.js';
import { docker, hostPath, type Runner } from './docker.js';

/** A file into a volume: source (relative to STACK_DIR), destination, owner uid:gid, mode. */
export interface VolumeFile {
  readonly from: string;
  readonly to: string;
  readonly owner: string;
  readonly mode: '0600' | '0644';
}

/** What each volume holds. Uids are the images' own users (postgres 999, PgBouncer 65532, Valkey 999, SeaweedFS 1000). */
export const VOLUMES: Readonly<Record<string, readonly VolumeFile[]>> = Object.freeze({
  'univarse-stack-pg-certs': [
    { from: 'certs/postgres.crt', to: 'server.crt', owner: '999:999', mode: '0644' },
    { from: 'certs/postgres.key', to: 'server.key', owner: '999:999', mode: '0600' },
    { from: 'rendered/pg_hba.conf', to: 'pg_hba.conf', owner: '999:999', mode: '0644' },
  ],
  'univarse-stack-pgbouncer-conf': [
    { from: 'rendered/pgbouncer.ini', to: 'pgbouncer.ini', owner: '65532:65532', mode: '0644' },
    { from: 'rendered/userlist.txt', to: 'userlist.txt', owner: '65532:65532', mode: '0600' },
    { from: 'certs/pgbouncer.crt', to: 'tls/server.crt', owner: '65532:65532', mode: '0644' },
    { from: 'certs/pgbouncer.key', to: 'tls/server.key', owner: '65532:65532', mode: '0600' },
    { from: 'certs/ca.crt', to: 'tls/ca.crt', owner: '65532:65532', mode: '0644' },
  ],
  'univarse-stack-valkey-conf': [{ from: 'rendered/valkey.conf', to: 'valkey.conf', owner: '999:1000', mode: '0600' }],
  'univarse-stack-seaweedfs-conf': [{ from: 'rendered/s3.json', to: 's3.json', owner: '1000:1000', mode: '0600' }],
  // The CA certificate only (never its key): the API, worker and migrate job trust it (NODE_EXTRA_CA_CERTS).
  'univarse-stack-ca': [{ from: 'certs/ca.crt', to: 'ca.crt', owner: '0:0', mode: '0644' }],
  // B2: Caddy's wildcard certificate and its key. The edge CA's key stays in STACK_DIR/edge.
  'univarse-stack-caddy-tls': [
    { from: 'edge/edge.crt', to: 'edge.crt', owner: '65532:65532', mode: '0644' },
    { from: 'edge/edge.key', to: 'edge.key', owner: '65532:65532', mode: '0600' },
  ],
});

/** The shell script that refills one volume: fixed paths from VOLUMES, nothing from outside. */
export function fillScript(files: readonly VolumeFile[]): string {
  const safe = /^[a-z0-9_./-]+$/;
  const lines = ['set -eu', 'find /dst -mindepth 1 -delete'];
  for (const f of files) {
    for (const p of [f.from, f.to]) if (!safe.test(p) || p.includes('..')) throw new Error(`unsafe volume path ${p}`);
    if (!/^\d+:\d+$/.test(f.owner)) throw new Error(`bad owner ${f.owner}`);
    lines.push(`mkdir -p "$(dirname /dst/${f.to})"`, `cp /src/${f.from} /dst/${f.to}`, `chown ${f.owner} /dst/${f.to}`, `chmod ${f.mode} /dst/${f.to}`);
  }
  // Directories (tls/) are readable by their owner only.
  lines.push(`find /dst -mindepth 1 -type d -exec chmod 0700 {} +`, `find /dst -mindepth 1 -type d -exec chown ${files[0]?.owner ?? '0:0'} {} +`);
  return lines.join('\n');
}

/** The running services that read each volume, and so must restart when its content changes (a process reads it at start). */
export const VOLUME_SERVICES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'univarse-stack-pg-certs': ['postgres'],
  'univarse-stack-pgbouncer-conf': ['pgbouncer'],
  'univarse-stack-valkey-conf': ['valkey'],
  'univarse-stack-seaweedfs-conf': ['seaweedfs'],
  'univarse-stack-ca': ['api', 'worker'],
  'univarse-stack-caddy-tls': ['caddy'],
});

/** What a volume will hold: each file's place, owner, mode and content, digested (never stored or shown in clear). */
export function volumeDigest(files: readonly VolumeFile[], dir = STACK_DIR): string {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.to}\0${f.owner}\0${f.mode}\0`).update(readFileSync(join(dir, f.from))).update('\0');
  return h.digest('hex');
}

const digestsFile = (dir: string) => join(dir, 'volumes.json');
/** Per volume: the content now in it (`filled`), and the content its services have loaded (`applied`). */
interface VolumeState {
  filled: Record<string, string>;
  applied: Record<string, string>;
}
const loadState = (dir: string): VolumeState => {
  const file = digestsFile(dir);
  const s = (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) as Partial<VolumeState>;
  return { filled: s.filled ?? {}, applied: s.applied ?? {} };
};
const saveState = (dir: string, s: VolumeState) => {
  writeOwnerOnly(digestsFile(dir), `${JSON.stringify(s, null, 2)}\n`);
};

/**
 * Fills each volume whose content changed (or that doesn't exist), and returns the services that haven't loaded their
 * volumes' current content: they keep the old files in memory until restarted (a rotated certificate, a new
 * password). The need survives a deploy that stops before restarting (a sealed Vault, a failed job): only
 * `markApplied`, after the restarts, clears it.
 */
export function fillVolumes({ dir = STACK_DIR, run = docker }: { dir?: string; run?: Runner } = {}): string[] {
  const state = loadState(dir);
  const restart = new Set<string>();
  for (const [volume, files] of Object.entries(VOLUMES)) {
    const digest = volumeDigest(files, dir);
    const exists = run(['volume', 'inspect', volume], { allowFail: true }).status === 0;
    if (!exists || state.filled[volume] !== digest) {
      run(['volume', 'create', volume]);
      run(['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh', '-v', `${hostPath(dir)}:/src:ro`, '-v', `${volume}:/dst`, THIRD_PARTY.postgres, '-c', fillScript(files)]);
      state.filled[volume] = digest;
      if (!exists) state.applied[volume] = ''; // a recreated volume: its services must load it again
      saveState(dir, state);
    }
    if (state.applied[volume] !== digest) for (const s of VOLUME_SERVICES[volume] ?? []) restart.add(s);
  }
  return [...restart];
}

/** After the restarts: every service has loaded what its volumes now hold. */
export function markApplied({ dir = STACK_DIR }: { dir?: string } = {}): void {
  const state = loadState(dir);
  saveState(dir, { filled: state.filled, applied: { ...state.filled } });
}

export const renderedDir = (dir = STACK_DIR) => join(dir, 'rendered');
