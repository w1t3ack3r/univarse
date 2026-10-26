// Spec 0020 B2-5: what a restore runs against. Its own compose project (`univarse-restore`), its own labelled volumes,
// and a temporary owner-only directory for its env files; for a real restore (B2-12), the three data volumes are the
// stack's own. Commands are argument arrays and secrets reach containers by env file or `-e NAME`, as everywhere in
// the stack's tooling.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { REPO, THIRD_PARTY } from '../config.js';
import { docker, type Runner } from '../docker.js';
import type { Run, Runner as JobRunner } from '../ledger/job.js';
import { VOLUMES, type VolumeFile } from '../volumes.js';

export const RESTORE_PROJECT = 'univarse-restore';
export const RESTORE_COMPOSE = join(REPO, 'infra', 'stack', 'restore.compose.yml');
/** Every container, network and volume a restore creates carries it, so a crashed run's leftovers are found by it. */
export const LABEL = 'univarse.restore';
export const VAULT = `${RESTORE_PROJECT}-vault-1`;
export const POSTGRES = `${RESTORE_PROJECT}-postgres-1`;
export const SEAWEEDFS = `${RESTORE_PROJECT}-seaweedfs-1`;
export const APP_NETWORK = `${RESTORE_PROJECT}_app`;

/** The volumes the restore's compose file names, by its variables or fixed names (restore.compose.yml). */
export interface DataVolumes {
  readonly pgdata: string;
  readonly vaultRaft: string;
  readonly seaweedfsData: string;
}
export const REHEARSAL_DATA: DataVolumes = { pgdata: 'univarse-restore-pgdata', vaultRaft: 'univarse-restore-vault-raft', seaweedfsData: 'univarse-restore-seaweedfs-data' };
/** The stack's own: compose names `pgdata` and `seaweedfs-data` itself; Raft is the deploy's (volumes.ts DATA_VOLUMES). */
export const STACK_DATA: DataVolumes = { pgdata: 'univarse-stack_pgdata', vaultRaft: 'univarse-stack-vault-raft', seaweedfsData: 'univarse-stack_seaweedfs-data' };
export const WAL_VOLUME = 'univarse-restore-wal';
export const AUDIT_VOLUME = 'univarse-restore-vault-audit';
/** B2-8: the files' plaintext between the host and the filer, inside Docker only. */
export const FILES_SCRATCH = 'univarse-restore-files';

/** The stack's configuration volumes the restore needs, under its own names, filled exactly as the deploy fills them. */
export const CONFIG_VOLUMES: Readonly<Record<string, readonly VolumeFile[]>> = Object.fromEntries(
  ['univarse-stack-pg-certs', 'univarse-stack-pgbouncer-conf', 'univarse-stack-valkey-conf', 'univarse-stack-seaweedfs-conf', 'univarse-stack-ca', 'univarse-stack-vault-tls'].map((v) => {
    const files = VOLUMES[v];
    if (!files) throw new Error(`no volume ${v}`);
    return [v === 'univarse-stack-ca' ? 'univarse-restore-ca' : v.replace('univarse-stack-', 'univarse-restore-'), files];
  }),
);

/** The owners a fresh data volume's root needs (the images' users), as the deploy sets them for its own. */
export const DATA_OWNERS = (d: DataVolumes): Readonly<Record<string, string>> => ({
  [d.pgdata]: '999:999',
  [WAL_VOLUME]: '999:999',
  [d.vaultRaft]: '100:1000',
  [AUDIT_VOLUME]: '100:1000',
  [d.seaweedfsData]: '1000:1000',
  [FILES_SCRATCH]: '1000:1000',
});

/** A labelled volume, created if missing, its root owned to `owner`. */
export function labelledVolume(name: string, owner: string, run: Runner = docker): void {
  if (!/^[a-z0-9_.-]+$/.test(name) || !/^\d+:\d+$/.test(owner)) throw new Error(`bad volume ${name} or owner ${owner}`);
  if (run(['volume', 'inspect', name], { allowFail: true }).status !== 0) run(['volume', 'create', '--label', `${LABEL}=1`, name]);
  run(['run', '--rm', '--network', 'none', '--user', '0:0', '--label', `${LABEL}=1`, '--entrypoint', 'sh', '-v', `${name}:/v`, THIRD_PARTY.postgres, '-c', `chown ${owner} /v && chmod 0700 /v`]);
}

/** The environment compose reads the restore's file with. */
export interface ComposeEnv {
  readonly dir: string;
  readonly data: DataVolumes;
  readonly images: Readonly<Record<string, string>>;
  /** `recovery_target_lsn=…` or `recovery_target_time=…`; a placeholder until PostgreSQL starts. */
  readonly target?: string;
}

const env = (e: ComposeEnv) => ({
  ...process.env,
  MSYS_NO_PATHCONV: '1',
  UNIVARSE_RESTORE_DIR: e.dir,
  UNIVARSE_RESTORE_PGDATA: e.data.pgdata,
  UNIVARSE_RESTORE_VAULT_RAFT: e.data.vaultRaft,
  UNIVARSE_RESTORE_SEAWEEDFS_DATA: e.data.seaweedfsData,
  UNIVARSE_RESTORE_TARGET: e.target ?? 'recovery_target_action=promote',
  ...e.images,
});

/** `docker compose` against the restore's project, its output shown (as the deploy's is). */
export function compose(args: readonly string[], e: ComposeEnv): { status: number } {
  const r = spawnSync('docker', ['compose', '-p', RESTORE_PROJECT, '-f', RESTORE_COMPOSE, ...args], { stdio: 'inherit', env: env(e) });
  return { status: r.status ?? 1 };
}

const JOB_TIMEOUT_MS = 10 * 60_000;
/** A one-shot job in the restore's project (A2-8's discipline: a job that didn't answer is removed, never left running). */
export function jobRunner(service: 'keys' | 'migrate', e: ComposeEnv, entry: readonly string[]): JobRunner {
  return (args, opts = {}): Run => {
    const name = `uv-restore-${service}-${randomUUID().slice(0, 8)}`;
    const r = spawnSync('docker', ['compose', '-p', RESTORE_PROJECT, '-f', RESTORE_COMPOSE, '--profile', 'job', 'run', '--rm', '-T', '--name', name, ...(opts.op ? ['-e', `UNIVARSE_DESTRUCTION_OP=${opts.op}`] : []), service, ...entry, ...args], {
      encoding: 'utf8',
      timeout: JOB_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      ...(opts.input === undefined ? {} : { input: opts.input }),
      env: env(e),
    });
    if (r.status !== 0 && r.status !== 3) docker(['rm', '-f', name], { allowFail: true });
    return { status: r.error ? null : r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

/** `docker <args>` with `source` on its stdin, for what is too large to buffer (a base backup, a snapshot, the files). */
export function pipeInto(args: readonly string[], source: Readable, extraEnv: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: { ...process.env, MSYS_NO_PATHCONV: '1', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failed: Error | null = null;
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf8')).slice(-4000)));
    // A failing source (a refused artifact) kills the child: nothing half-written is ever taken for done.
    source.on('error', (e) => {
      failed = e;
      child.kill();
    });
    child.stdin.on('error', () => undefined);
    source.pipe(child.stdin);
    child.on('error', reject);
    child.on('close', (code) => (failed ? reject(failed) : resolve({ status: code ?? 1, stdout, stderr })));
  });
}

/** Everything labelled: containers first, then networks and volumes. Returns what it removed, by kind and count. */
export function removeLabelled(run: Runner = docker): string[] {
  const ids = (args: string[]) => run(args, { allowFail: true }).stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const containers = ids(['ps', '-aq', '--filter', `label=${LABEL}`]);
  if (containers.length) run(['rm', '-f', ...containers], { allowFail: true });
  const networks = ids(['network', 'ls', '-q', '--filter', `label=${LABEL}`]);
  if (networks.length) run(['network', 'rm', ...networks], { allowFail: true });
  const volumes = ids(['volume', 'ls', '-q', '--filter', `label=${LABEL}`]);
  if (volumes.length) run(['volume', 'rm', '-f', ...volumes], { allowFail: true });
  const left = [...ids(['ps', '-aq', '--filter', `label=${LABEL}`]), ...ids(['volume', 'ls', '-q', '--filter', `label=${LABEL}`])];
  if (left.length) throw new Error(`${String(left.length)} labelled containers or volumes could not be removed`);
  return containers.length + networks.length + volumes.length ? [`removed ${String(containers.length)} containers, ${String(networks.length)} networks, ${String(volumes.length)} volumes labelled ${LABEL}`] : [];
}
