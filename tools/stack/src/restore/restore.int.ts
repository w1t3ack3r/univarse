// Spec 0020 B2-13: the restore's own steps (restore/steps.ts, exactly what the rehearsal runs) on the stack's pinned
// images, without the release's app images, in containers and volumes of their own. CI only (`test:restore`).
//   BK4: PostgreSQL 18 with a base backup, a row before the target time and one after, the WAL archived, sealed and
//        shipped by the real shipper; recovered to the time, the first row is there and the second isn't. A time past
//        the WAL is refused in PostgreSQL's own words.
//   BK5's second half: a Raft snapshot from one Vault, sealed, restored into a fresh Vault, and opened with the first
//        Vault's own unseal key; a probe encrypted before decrypts after.
//   B2-8: files written through the filer from a one-shot container, each read back over S3 and hashed there.
//   BK6: a crashed run's labelled containers and volumes are all removed by their label.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASEBACKUP_ARGS, startOf } from '../backup/pgbase.js';
import { writeSealed } from '../backup/set.js';
import { dockerStream } from '../backup/stream.js';
import { tarStream } from '../backup/tar.js';
import { realWalDeps, shipWal } from '../backup/wal.js';
import { COMPOSE_FILE, PROJECT, THIRD_PARTY } from '../config.js';
import { docker, hostPath } from '../docker.js';
import { cliEnv, initialise, loadVaultInit, vaultCli, vaultState, type VaultTarget } from '../vault.js';
import { openArtifact } from './artifact.js';
import { recovered, restoreFilesThrough, restoreSnapshot, targetSetting, unpackBase, unpackWal, walEntries } from './steps.js';
import { FILES_SCRATCH, LABEL, labelledVolume, removeLabelled } from './target.js';
import { walNeed } from './wal-range.js';

if (process.env.CI !== 'true') throw new Error('restore.int runs in CI only (it creates and removes Docker containers, volumes and networks)');

const id = randomBytes(3).toString('hex');
const KEYS = generateKeyPairSync('x25519');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let root: string;
const made = { containers: [] as string[], volumes: [] as string[], networks: [] as string[] };
const container = (name: string) => (made.containers.push(name), name);
const volume = (name: string) => (made.volumes.push(name), name);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-restore-int-'));
});
afterAll(() => {
  if (made.containers.length) docker(['rm', '-f', ...made.containers], { allowFail: true });
  if (made.networks.length) docker(['network', 'rm', ...made.networks], { allowFail: true });
  if (made.volumes.length) docker(['volume', 'rm', '-f', ...made.volumes], { allowFail: true });
  rmSync(root, { recursive: true, force: true });
});

/** The stack's archive settings, as compose resolves them from infra/stack/compose.yml (as pg-archive.int does). */
function archiveSettings(): string[] {
  const d = mkdtempSync(join(tmpdir(), 'uv-restore-compose-'));
  try {
    for (const f of ['postgres.env', 'migrate.env', 'api.env', 'worker.env', 'web.env', 'keys.env', 'backup.env']) writeFileSync(join(d, f), '');
    const stand = Object.fromEntries(['UNIVARSE_API_IMAGE', 'UNIVARSE_WEB_IMAGE', 'UNIVARSE_MIGRATE_IMAGE', 'UNIVARSE_PGBOUNCER_IMAGE'].map((v) => [v, `localhost:5000/x@sha256:${'1'.repeat(64)}`]));
    const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'config', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, UNIVARSE_STACK_DIR: d, ...stand } });
    const cmd = (JSON.parse(r.stdout) as { services: { postgres: { command: string[] } } }).services.postgres.command;
    const out: string[] = [];
    for (let i = 0; i < cmd.length; i++) if (cmd[i] === '-c' && /^(archive_|wal_keep_size)/.test(cmd[i + 1] ?? '')) out.push('-c', cmd[i + 1] ?? '');
    return out;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const sql = (name: string, q: string) => docker(['exec', '-u', 'postgres', name, 'psql', '-qAt', '-d', 'postgres', '-c', q], { allowFail: true }).stdout.trim();
async function ready(name: string): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    if (docker(['inspect', '-f', '{{.State.Running}}', name], { allowFail: true }).stdout.trim() !== 'true') return false;
    if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { allowFail: true }).status === 0) return true;
    await pause(1000);
  }
  return false;
}

describe('[BK4] PostgreSQL restored to a time, from a sealed base backup and the shipped WAL', () => {
  const src = container(`uv-restore-src-${id}`);
  const staging = volume(`uv-restore-staging-${id}`);
  const srcData = volume(`uv-restore-srcdata-${id}`);
  const dest = () => join(root, 'dest');
  let base: { record: { name: string; plainSha256: string; plainSize: number }; startWal: string; timeline: number };
  let target: Date;

  beforeAll(async () => {
    labelledVolume(staging, '999:999');
    labelledVolume(srcData, '999:999');
    docker(['run', '-d', '--name', src, '--user', '999:999', '-e', 'POSTGRES_PASSWORD=ci-only-not-a-secret', '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
      '-v', `${srcData}:/var/lib/postgresql`, '-v', `${staging}:/wal-staging`, THIRD_PARTY.postgres, 'postgres', ...archiveSettings()]);
    expect(await ready(src)).toBe(true);
    sql(src, "CREATE ROLE univarse_backup WITH LOGIN REPLICATION PASSWORD 'ci-only-not-a-secret'; CREATE TABLE r (x text)");
    // The base backup, sealed as it streams, exactly as the backup seals it.
    let stderr = '';
    const stream = dockerStream(['exec', '-u', 'postgres', src, 'pg_basebackup', '-h', '/var/run/postgresql', '-U', 'univarse_backup', ...BASEBACKUP_ARGS], { onStderr: (t) => (stderr += t) });
    const path = join(root, 'postgres.tar.seal');
    const sealed = await writeSealed(path, stream, KEYS.publicKey);
    const start = startOf(stderr);
    base = { record: { name: 'postgres.tar.seal', ...sealed }, startWal: start.startWal, timeline: start.timeline };
    // A row before the target, the target itself, and a row after it, in segments that are then archived and shipped.
    sql(src, "INSERT INTO r VALUES ('before')");
    await pause(1500);
    target = new Date(sql(src, "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"));
    await pause(1500);
    sql(src, "INSERT INTO r VALUES ('after')");
    const last = sql(src, 'SELECT pg_walfile_name(pg_current_wal_lsn())');
    sql(src, 'SELECT pg_switch_wal()');
    for (let i = 0; i < 60 && !docker(['run', '--rm', '-v', `${staging}:/w:ro`, '--entrypoint', 'ls', THIRD_PARTY.postgres, '/w'], { allowFail: true }).stdout.split('\n').includes(last); i++) await pause(500);
    const shipped = await shipWal(dest(), KEYS.publicKey, realWalDeps(docker, dockerStream, staging));
    expect(shipped.shipped).toBeGreaterThan(0);
  }, 300_000);

  /** One restore of the sealed set into fresh volumes, to `to`; the container's name. */
  async function restoreTo(to: Date, n: string): Promise<{ name: string; problems: string[] }> {
    const data = volume(`uv-restore-pg-${n}-${id}`);
    const wal = volume(`uv-restore-wal-${n}-${id}`);
    labelledVolume(data, '999:999');
    labelledVolume(wal, '999:999');
    expect(await unpackBase(data, openArtifact(join(root, 'postgres.tar.seal'), base.record, KEYS.privateKey))).toEqual([]);
    const walDir = join(dest(), 'wal', base.timeline.toString(16).toUpperCase().padStart(8, '0'));
    const need = walNeed(base.startWal, base.timeline, 'newest', readdirSync(walDir).map((f) => f.replace(/\.gz\.seal$/, '')));
    if (need.state !== 'complete') throw new Error(`the WAL isn't complete: ${need.state}`);
    expect(await unpackWal(wal, walEntries(walDir, need.files, KEYS.privateKey))).toEqual([]);
    const name = container(`uv-restore-dst-${n}-${id}`);
    // restore.compose.yml's recovery settings, without the stack's TLS (its certificates are the deploy's).
    docker(['run', '-d', '--name', name, '--user', '999:999', '-v', `${data}:/var/lib/postgresql`, '-v', `${wal}:/wal-restore:ro`, THIRD_PARTY.postgres, 'postgres',
      '-c', 'archive_mode=off', '-c', 'restore_command=cp /wal-restore/%f %p', '-c', targetSetting({ time: to }), '-c', 'recovery_target_action=promote']);
    const ok = await ready(name);
    const logs = docker(['logs', name], { allowFail: true });
    return { name, problems: await recovered({ time: to }, ok, logs.stdout + logs.stderr, (q) => sql(name, q), need.files.at(-1)) };
  }

  it('recovered to the time: the row before it is there, the row after it is not, and it promoted', async () => {
    const r = await restoreTo(target, 'time');
    expect(r.problems).toEqual([]);
    expect(sql(r.name, 'SELECT x FROM r ORDER BY x')).toBe('before');
    expect(sql(r.name, 'SELECT pg_is_in_recovery()')).toBe('f');
  }, 300_000);

  it('a time past the shipped WAL is refused, in PostgreSQL\'s own words', async () => {
    const r = await restoreTo(new Date(target.getTime() + 24 * 3600_000), 'late');
    expect(r.problems.join()).toMatch(/^target not reached: PostgreSQL ran out of WAL/);
  }, 300_000);
});

describe('[BK5] Vault restored from a sealed Raft snapshot, opened with the first Vault\'s own key', () => {
  const HCL = 'storage "raft" {\n  path = "/vault/raft"\n  node_id = "n1"\n}\nlistener "tcp" {\n  address = "0.0.0.0:8200"\n  tls_disable = true\n}\napi_addr = "http://127.0.0.1:8200"\ncluster_addr = "http://127.0.0.1:8201"\ndisable_mlock = true\nui = false';
  const start = (name: string) => {
    docker(['run', '-d', '--name', container(name), '--user', '100:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--tmpfs', '/vault/raft:uid=100,gid=1000', '--tmpfs', '/tmp:uid=100,gid=1000', '--tmpfs', '/vault/logs:uid=100,gid=1000',
      '--entrypoint', 'sh', THIRD_PARTY.vault, '-c', `printf '%s\\n' '${HCL}' > /tmp/v.hcl && exec vault server -config=/tmp/v.hcl`]);
    return { container: name, tls: false } satisfies VaultTarget;
  };
  const CONTEXT = Buffer.from('univarse-restore-probe').toString('base64');

  it('a probe encrypted on the first decrypts on the restored one, with the same app token', async () => {
    const dir = mkdtempSync(join(root, 'vault-'));
    const a = start(`uv-restore-vault-a-${id}`);
    for (let i = 0; i < 40 && vaultState(docker, a) !== 'uninitialised'; i++) await pause(500);
    initialise(docker, dir, a);
    const init = loadVaultInit(dir);
    const plain = Buffer.from(`probe-${id}`).toString('base64');
    const enc = vaultCli(docker, ['write', '-format=json', 'transit/encrypt/univarse-kek', `context=${CONTEXT}`, 'plaintext=-'], { VAULT_TOKEN: init.appToken }, plain, a);
    const ciphertext = (JSON.parse(enc.stdout) as { data: { ciphertext: string } }).data.ciphertext;
    // The snapshot, as the backup takes it (its own token), sealed as it streams.
    const snap = dockerStream(['exec', ...cliEnv(a), '-e', 'VAULT_TOKEN', a.container, 'vault', 'operator', 'raft', 'snapshot', 'save', '/dev/stdout'], { env: { VAULT_TOKEN: init.backupToken ?? '' } });
    const path = join(root, 'vault.snap.seal');
    const sealed = await writeSealed(path, snap, KEYS.publicKey);

    const b = start(`uv-restore-vault-b-${id}`);
    for (let i = 0; i < 40 && vaultState(docker, b) !== 'uninitialised'; i++) await pause(500);
    expect(await restoreSnapshot(b, openArtifact(path, { name: 'vault.snap.seal', ...sealed }, KEYS.privateKey), dir)).toEqual([]);
    expect(vaultState(docker, b)).toBe('ready');
    const dec = vaultCli(docker, ['write', '-format=json', 'transit/decrypt/univarse-kek', `context=${CONTEXT}`, `ciphertext=${ciphertext}`], { VAULT_TOKEN: init.appToken }, undefined, b);
    expect((JSON.parse(dec.stdout) as { data: { plaintext: string } }).data.plaintext).toBe(plain);
  }, 300_000);
});

describe('[B2-8] files back through the filer, each read back over S3', () => {
  it('every object, its key and its bytes unchanged, spaces and non-ASCII names included', async () => {
    const net = `uv-restore-net-${id}`;
    made.networks.push(net);
    docker(['network', 'create', '--internal', '--label', `${LABEL}=1`, net]);
    const conf = mkdtempSync(join(root, 'sw-'));
    const access = `ci${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(16).toString('hex');
    writeFileSync(join(conf, 's3.json'), JSON.stringify({ identities: [{ name: 'univarse-app', credentials: [{ accessKey: access, secretKey: secret }], actions: ['Read', 'Write', 'List', 'Admin'] }] }));
    const sw = container(`uv-restore-sw-${id}`);
    docker(['run', '-d', '--name', sw, '--network', net, '--network-alias', 'seaweedfs', '-v', `${hostPath(conf)}:/etc/seaweedfs:ro`, '--entrypoint', '/usr/bin/weed', THIRD_PARTY.seaweedfs,
      'server', '-dir=/data', '-ip.bind=0.0.0.0', '-s3', '-s3.port=8333', '-s3.config=/etc/seaweedfs/s3.json', '-master.volumeSizeLimitMB=128', '-volume.max=4']);
    let created = false;
    for (let i = 0; i < 40 && !created; i++) {
      await pause(1500);
      const r = docker(['exec', '-i', '-e', 'HOME=/tmp', sw, '/usr/bin/weed', 'shell', '-master=127.0.0.1:9333', '-filer=127.0.0.1:8888'], { input: 's3.bucket.create -name uv-clean\ns3.bucket.list\n', allowFail: true });
      created = /^\s*uv-clean\s/m.test(r.stdout);
    }
    expect(created).toBe(true);
    labelledVolume(volume(FILES_SCRATCH), '1000:1000');
    const files = tarStream([
      { name: '0f1e2d3c-tenant/9a8b7c6d-file', data: randomBytes(70_000) },
      { name: 'tenant/sub dir/report 2026.pdf', data: randomBytes(5_000) },
      { name: "tenant/naïve-ü it's (1).txt", data: Buffer.from('a small one') },
    ]);
    const r = await restoreFilesThrough(net, files, { accessKey: access, secretKey: secret });
    expect(r).toEqual({ objects: 3, problems: [] });
  }, 300_000);
});

describe('[BK6] a crashed run leaves nothing its label doesn\'t find', () => {
  it('labelled containers, networks and volumes are all removed', () => {
    // The earlier tests' own containers hold some labelled volumes: gone first, as a crashed run's would be by now.
    if (made.containers.length) docker(['rm', '-f', ...made.containers], { allowFail: true });
    labelledVolume(`uv-restore-left-${id}`, '0:0');
    docker(['run', '-d', '--name', `uv-restore-left-${id}`, '--label', `${LABEL}=1`, '--entrypoint', 'sleep', THIRD_PARTY.postgres, '600']);
    removeLabelled();
    expect(docker(['ps', '-aq', '--filter', `label=${LABEL}`]).stdout.trim()).toBe('');
    expect(docker(['volume', 'ls', '-q', '--filter', `label=${LABEL}`]).stdout.trim()).toBe('');
  }, 120_000);
});
