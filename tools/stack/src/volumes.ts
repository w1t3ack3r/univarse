// Spec 0019: the configuration-and-key volumes (compose `external`), filled with exactly what each service reads,
// owned by that service's user, keys 0600. A short-lived tool container (the pinned PostgreSQL image, as root, no
// network) copies from STACK_DIR, read-only; it never prints a file. Each volume is emptied first, so nothing stale
// survives a rotation.
import { join } from 'node:path';
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

export function fillVolumes({ dir = STACK_DIR, run = docker }: { dir?: string; run?: Runner } = {}): void {
  for (const [volume, files] of Object.entries(VOLUMES)) {
    run(['volume', 'create', volume]);
    run(['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh', '-v', `${hostPath(dir)}:/src:ro`, '-v', `${volume}:/dst`, THIRD_PARTY.postgres, '-c', fillScript(files)]);
  }
}

export const renderedDir = (dir = STACK_DIR) => join(dir, 'rendered');
