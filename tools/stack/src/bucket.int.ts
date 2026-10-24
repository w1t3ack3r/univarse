// Spec 0020 (the bucket copy's fix, A2-10): the shred ledger's bucket copy against the stack's OWN SeaweedFS: its pinned
// image, user, entrypoint, environment, command and memory limit, as `docker compose config` resolves them from
// infra/stack/compose.yml, with s3.json from renderS3Config. Run by `pnpm --filter @univarse/stack test:bucket` (CI),
// never by the unit run. Three runs:
//   1. the owner's stack before the fix (2026-10-23): the same flags with 16 volumes and SeaweedFS's default growth, the
//      identity without PutObjectRetention. The filer's log, uv-quarantine and uv-clean take 7, 7 and 2 volumes, as
//      measured there; the ledger's locked put is refused (403) and even its plain put finds no volume;
//   2. the upgrade: the same data, restarted with this commit's settings. The real copyToBucket writes the entries; the
//      ledger's bucket grows by exactly one volume; retention, the identity's limits and `stack:bucket-check` all hold;
//   3. a fresh stack on this commit's settings: each bucket grows by exactly one volume.
// Docker by default. On a machine without a Docker daemon, SEAWEEDFS_BIN names a weed binary of the image's version,
// run on 127.0.0.1's default SeaweedFS ports (the Docker CLI still resolves the compose file). CI uses Docker.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectRetentionCommand, PutObjectCommand, PutObjectRetentionCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyToBucket } from '../../../apps/api/src/cli/ledger-copy.js';
import { bucketCheck } from './bucket-check.js';
import { COMPOSE_FILE, PROJECT } from './config.js';
import { BUCKETS } from './deploy-deps.js';
import { canonical, nextEntry, type Entry } from './ledger/chain.js';
import { renderS3Config } from './render.js';
import { generateSecrets } from './secrets.js';

const run = randomBytes(3).toString('hex');
const BIN = process.env.SEAWEEDFS_BIN;
const LEDGER_BUCKET = 'uv-shred-ledger';
const secrets = generateSecrets();

interface Service {
  image: string;
  user?: string;
  entrypoint?: string[];
  command: string[];
  environment?: Record<string, string>;
  mem_limit?: string | number;
}
interface Settings {
  command: readonly string[];
  environment: Readonly<Record<string, string>>;
  s3: string;
}

/** The seaweedfs service as compose resolves it (env files empty; the image variables stand in). */
function resolveService(): Service {
  const dir = mkdtempSync(join(tmpdir(), 'uv-bucket-compose-'));
  try {
    for (const f of ['postgres.env', 'migrate.env', 'api.env', 'worker.env', 'web.env', 'keys.env', 'backup.env']) writeFileSync(join(dir, f), '');
    const stand = Object.fromEntries(['UNIVARSE_API_IMAGE', 'UNIVARSE_WEB_IMAGE', 'UNIVARSE_MIGRATE_IMAGE', 'UNIVARSE_PGBOUNCER_IMAGE'].map((v) => [v, `localhost:5000/x@sha256:${'1'.repeat(64)}`]));
    const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'config', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, UNIVARSE_STACK_DIR: dir, ...stand } });
    if (r.status !== 0) throw new Error(`docker compose config failed: ${r.stderr}`);
    const s = (JSON.parse(r.stdout) as { services: Record<string, Service> }).services.seaweedfs;
    if (!s) throw new Error('no seaweedfs service');
    return s;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const service = resolveService();
const CURRENT: Settings = { command: service.command, environment: service.environment ?? {}, s3: renderS3Config(secrets) };
/**
 * What the owner's stack ran before this fix: 16 volumes, SeaweedFS's default growth (7 a collection), and the ledger
 * identity with `Write` alone. Derived from this commit's settings, and checked to differ from them, so the control
 * can't silently become the fix.
 */
const PRE_FIX: Settings = {
  command: CURRENT.command.map((a) => (a.startsWith('-volume.max=') ? '-volume.max=16' : a)),
  environment: Object.fromEntries(Object.entries(CURRENT.environment).filter(([k]) => !k.startsWith('WEED_MASTER_VOLUME_GROWTH_'))),
  s3: CURRENT.s3.replace(/,\s*"PutObjectRetention:uv-shred-ledger"/, ''),
};

/** One SeaweedFS process or container, on a data directory or volume that outlives it. */
interface Weed {
  endpoint: string;
  shell(commands: string): string;
  memory(): string;
  stop(): Promise<void>;
}

const work = mkdtempSync(join(tmpdir(), 'uv-bucket-'));
/** The configuration directory, as the conf volume is: readable by the container's user (1000). Throwaway keys. */
function confDir(name: string, s3: string): string {
  const dir = join(work, `conf-${name}`);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  writeFileSync(join(dir, 's3.json'), s3, { mode: 0o644 });
  chmodSync(join(dir, 's3.json'), 0o644);
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (args: readonly string[], input?: string) => spawnSync('docker', args, { encoding: 'utf8', ...(input === undefined ? {} : { input }) });

function startDocker(data: string, settings: Settings): Weed {
  const name = `uv-bucket-test-${run}`;
  const conf = confDir(data, settings.s3);
  const env = Object.entries(settings.environment).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = docker([
    'run', '-d', '--name', name, '--user', service.user ?? '1000:1000', '--entrypoint', service.entrypoint?.[0] ?? '/usr/bin/weed',
    '--memory', String(service.mem_limit ?? '256m'), '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    ...env, '-v', `${data}:/data`, '-v', `${conf}:/etc/seaweedfs:ro`, '-p', '127.0.0.1::8333', service.image, ...settings.command,
  ]);
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
  const port = docker(['port', name, '8333/tcp']).stdout.trim().split('\n')[0]?.split(':').at(-1) ?? '';
  return {
    endpoint: `http://127.0.0.1:${port}`,
    shell: (commands) => docker(['exec', '-i', '-e', 'HOME=/tmp', name, '/usr/bin/weed', 'shell', '-master=127.0.0.1:9333', '-filer=127.0.0.1:8888'], `${commands}\n`).stdout,
    memory: () => {
      const now = docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name]).stdout.trim();
      const peak = docker(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak']).stdout.trim();
      return `${now}${/^\d+$/.test(peak) ? `, peak ${(Number(peak) / 1024 / 1024).toFixed(0)}MiB` : ''}`;
    },
    stop: () => {
      docker(['rm', '-f', name]);
      return Promise.resolve();
    },
  };
}

function startBinary(data: string, settings: Settings): Weed {
  const conf = confDir(data, settings.s3);
  const dir = join(work, data);
  mkdirSync(dir, { recursive: true });
  const args = settings.command.map((a) =>
    a === '-dir=/data' ? `-dir=${dir}` : a === '-ip.bind=0.0.0.0' ? '-ip.bind=127.0.0.1' : a.startsWith('-s3.config=') ? `-s3.config=${join(conf, 's3.json')}` : a,
  );
  const child: ChildProcess = spawn(BIN ?? '', [...args, '-ip=127.0.0.1'], { env: { ...process.env, ...settings.environment }, stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return {
    endpoint: 'http://127.0.0.1:8333',
    shell: (commands) => spawnSync(BIN ?? '', ['shell', '-master=127.0.0.1:9333', '-filer=127.0.0.1:8888'], { encoding: 'utf8', input: `${commands}\n`, env: { ...process.env, HOME: tmpdir() } }).stdout,
    memory: () => `${(Number(spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).stdout.trim()) / 1024).toFixed(0)}MiB RSS (native)`,
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
      await sleep(1000);
    },
  };
}

/** Started, with its master, volume server, filer and S3 gateway all answering. */
async function start(data: string, settings: Settings): Promise<Weed> {
  const weed = (BIN ? startBinary : startDocker)(data, settings);
  for (let i = 0; i < 90; i++) {
    const top = /^Topology .*hdd\(volume:\d+\/(\d+)/m.exec(weed.shell('volume.list'));
    const s3 = await fetch(weed.endpoint).then(() => true, () => false);
    if (top && Number(top[1]) > 0 && s3) return weed;
    await sleep(1000);
  }
  await weed.stop();
  throw new Error('SeaweedFS did not start');
}

/** Volumes per collection ('' is the filer's own log), and the free slots, from `volume.list`. */
function volumes(weed: Weed): { by: Record<string, number>; free: number; max: number } {
  const out = weed.shell('volume.list');
  const by: Record<string, number> = {};
  for (const m of out.matchAll(/^\s*volume Id:\d+,.*?Collection:([^,]*),/gm)) by[m[1] ?? ''] = (by[m[1] ?? ''] ?? 0) + 1;
  const top = /^Topology .*hdd\(volume:(\d+)\/(\d+) active:\d+ free:(\d+)/m.exec(out);
  return { by, free: Number(top?.[3] ?? NaN), max: Number(top?.[2] ?? NaN) };
}

/** The buckets, exactly as the deploy creates them (deploy-deps.ts), the ledger's with object lock and its owner. */
async function createBuckets(weed: Weed): Promise<void> {
  weed.shell(Object.entries(BUCKETS).map(([b, opts]) => `s3.bucket.create -name ${b}${opts}`).join('\n'));
  for (let i = 0; i < 30; i++) {
    const listed = weed.shell('s3.bucket.list');
    if (Object.keys(BUCKETS).every((b) => new RegExp(`^\\s*${b}\\s`, 'm').test(listed))) return;
    await sleep(1000);
  }
  throw new Error('the buckets were not created');
}

const client = (weed: Weed, accessKeyId: string, secretAccessKey: string) =>
  new S3Client({ endpoint: weed.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const outcome = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => status(e) ?? 0);

function chain(n: number): Entry[] {
  const out: Entry[] = [nextEntry(null, { type: 'genesis', ledgerId: randomUUID(), generation: 1, destinations: [{ id: 'primary', path: '/ledger' }] })];
  for (let i = 1; i < n; i++) out.push(nextEntry(out[i - 1] ?? null, { type: 'audited', attempt: randomUUID(), auditSeq: String(i) }));
  return out;
}
const ledgerIdOf = (entries: readonly Entry[]) => (entries[0]?.type === 'genesis' ? entries[0].ledgerId : '');

const dataVolumes: string[] = [];
const dataVolume = (label: string) => {
  const name = `uv-bucket-test-${run}-${label}`;
  dataVolumes.push(name);
  return name;
};
let weed: Weed | undefined;

beforeAll(() => {
  if (BIN) {
    const v = spawnSync(BIN, ['version'], { encoding: 'utf8' }).stdout;
    const tag = /:(\d+\.\d+)@/.exec(service.image)?.[1] ?? '';
    if (!tag || !v.includes(` ${tag} `)) throw new Error(`SEAWEEDFS_BIN is not SeaweedFS ${tag}, the stack's image (${v.trim()})`);
  }
});
afterAll(async () => {
  await weed?.stop();
  if (!BIN) for (const v of dataVolumes) docker(['volume', 'rm', '-f', v]);
  rmSync(work, { recursive: true, force: true });
});

describe('[A2-10] the shred ledger\'s bucket copy, on the stack\'s SeaweedFS', () => {
  const data = dataVolume('owner');
  const entries = chain(3);
  const ledgerId = ledgerIdOf(entries);
  const lines = entries.map((e) => canonical(e));

  it('[A2-10] the control differs from this commit in exactly the three settings the fix changes', () => {
    expect(PRE_FIX.command).not.toEqual(CURRENT.command);
    expect(PRE_FIX.command.filter((a, i) => a !== CURRENT.command[i])).toEqual(['-volume.max=16']);
    expect(Object.keys(CURRENT.environment).filter((k) => !(k in PRE_FIX.environment))).toEqual(['WEED_MASTER_VOLUME_GROWTH_COPY_1']);
    expect(PRE_FIX.s3).not.toBe(CURRENT.s3);
    expect(PRE_FIX.s3).not.toContain('PutObjectRetention');
  });

  it('[A2-10] before the fix (the owner\'s stack, 2026-10-23): 7, 7 and 2 volumes; the locked put refused (403), and no volume even for a plain one', async () => {
    weed = await start(data, PRE_FIX);
    await createBuckets(weed);
    // The filer's own log (collection '') is written about a minute after the buckets are: it grew first there.
    for (let i = 0; i < 150 && !(volumes(weed).by[''] ?? 0); i++) await sleep(1000);
    const app = client(weed, secrets.s3AccessKey, secrets.s3SecretKey);
    const led = client(weed, secrets.ledgerS3AccessKey, secrets.ledgerS3SecretKey);
    try {
      await app.send(new PutObjectCommand({ Bucket: 'uv-quarantine', Key: 'a', Body: 'x' }));
      await app.send(new PutObjectCommand({ Bucket: 'uv-clean', Key: 'a', Body: 'x' }));
      expect(volumes(weed)).toEqual({ by: { '': 7, 'uv-quarantine': 7, 'uv-clean': 2 }, free: 0, max: 16 });
      const until = new Date(Date.now() + 10 * 365 * 86_400_000);
      expect(await outcome(led.send(new PutObjectCommand({ Bucket: LEDGER_BUCKET, Key: 'probe-locked', Body: 'x', ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: until })))).toBe(403);
      // Authorised, but there is nowhere to write it.
      expect(await outcome(led.send(new PutObjectCommand({ Bucket: LEDGER_BUCKET, Key: 'probe-plain', Body: 'x' })))).toBeGreaterThanOrEqual(500);
      await expect(copyToBucket({ endpoint: weed.endpoint, region: 'us-east-1', accessKeyId: secrets.ledgerS3AccessKey, secretAccessKey: secrets.ledgerS3SecretKey, ledgerId, generation: 'gen-0001' }, lines)).rejects.toThrow();
    } finally {
      app.destroy();
      led.destroy();
    }
    await weed.stop();
    weed = undefined;
  });

  it('[A2-10] the upgrade (same data, this commit\'s settings): the copy is written, and the ledger\'s bucket grows by exactly one volume', async () => {
    weed = await start(data, CURRENT);
    const before = volumes(weed);
    expect(before.by).toEqual({ '': 7, 'uv-quarantine': 7, 'uv-clean': 2 });
    const written = await copyToBucket({ endpoint: weed.endpoint, region: 'us-east-1', accessKeyId: secrets.ledgerS3AccessKey, secretAccessKey: secrets.ledgerS3SecretKey, ledgerId, generation: 'gen-0001' }, lines);
    expect(written).toBe(3);
    const after = volumes(weed);
    expect(after.by).toEqual({ '': 7, 'uv-quarantine': 7, 'uv-clean': 2, [LEDGER_BUCKET]: 1 });
    expect([after.max, after.free]).toEqual([24, 24 - 17]);
    console.log(`[bucket.int] SeaweedFS memory after the upgrade (17 volumes, limit ${String(Number(service.mem_limit) / 1024 / 1024)}MiB): ${weed.memory()}`);
  });

  it('[A2-10] each entry is retained in COMPLIANCE mode for 10 years, and the ledger identity can neither shorten nor drop it', async () => {
    if (!weed) throw new Error('no SeaweedFS');
    const app = client(weed, secrets.s3AccessKey, secrets.s3SecretKey);
    const led = client(weed, secrets.ledgerS3AccessKey, secrets.ledgerS3SecretKey);
    const Key = `${ledgerId}/gen-0001/${String(1).padStart(10, '0')}-${entries[0]?.hash ?? ''}.json`;
    try {
      const r = await app.send(new GetObjectRetentionCommand({ Bucket: LEDGER_BUCKET, Key }));
      expect(r.Retention?.Mode).toBe('COMPLIANCE');
      const years = (new Date(r.Retention?.RetainUntilDate ?? 0).getTime() - Date.now()) / (365.25 * 86_400_000);
      expect(years).toBeGreaterThan(9.99);
      expect(years).toBeLessThan(10.01);
      const shorter = new Date(Date.now() + 86_400_000);
      expect(await outcome(led.send(new PutObjectRetentionCommand({ Bucket: LEDGER_BUCKET, Key, Retention: { Mode: 'COMPLIANCE', RetainUntilDate: shorter } })))).not.toBe(200);
      expect(await outcome(led.send(new PutObjectRetentionCommand({ Bucket: LEDGER_BUCKET, Key, Retention: { Mode: 'GOVERNANCE', RetainUntilDate: shorter } })))).not.toBe(200);
      expect((await app.send(new GetObjectRetentionCommand({ Bucket: LEDGER_BUCKET, Key }))).Retention).toEqual(r.Retention);
    } finally {
      app.destroy();
      led.destroy();
    }
  });

  it('[A2-10] pnpm stack:bucket-check passes on it, --try-delete included', async () => {
    if (!weed) throw new Error('no SeaweedFS');
    const app = client(weed, secrets.s3AccessKey, secrets.s3SecretKey);
    const led = client(weed, secrets.ledgerS3AccessKey, secrets.ledgerS3SecretKey);
    try {
      const result = await bucketCheck({ ledger: { ledgerId, dir: 'gen-0001', entries }, app, ledgerIdentity: led, tryDelete: true });
      expect(result.filter((l) => !l.startsWith('PASS'))).toEqual([]);
      expect(result).toHaveLength(13);
    } finally {
      app.destroy();
      led.destroy();
    }
    await weed.stop();
    weed = undefined;
  });

  it('[A2-10] a fresh stack on this commit\'s settings: each bucket grows by exactly one volume', async () => {
    weed = await start(dataVolume('fresh'), CURRENT);
    await createBuckets(weed);
    const app = client(weed, secrets.s3AccessKey, secrets.s3SecretKey);
    try {
      for (const b of ['uv-quarantine', 'uv-clean']) await app.send(new PutObjectCommand({ Bucket: b, Key: 'a', Body: 'x' }));
      const fresh = chain(1);
      await copyToBucket({ endpoint: weed.endpoint, region: 'us-east-1', accessKeyId: secrets.ledgerS3AccessKey, secretAccessKey: secrets.ledgerS3SecretKey, ledgerId: ledgerIdOf(fresh), generation: 'gen-0001' }, fresh.map((e) => canonical(e)));
      const { by } = volumes(weed);
      expect([by['uv-quarantine'], by['uv-clean'], by[LEDGER_BUCKET]]).toEqual([1, 1, 1]);
    } finally {
      app.destroy();
    }
  });
});
