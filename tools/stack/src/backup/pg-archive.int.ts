// Spec 0020 B-2 and B-3 against the stack's own PostgreSQL 18 (its pinned image, user, and archive settings as
// `docker compose config` resolves them from infra/stack/compose.yml), in a container of its own, on a staging volume of
// its own: a finished segment is staged whole, nothing fails to archive, and pg_basebackup with B1's exact arguments
// reports its start point and carries its manifest in the tar stream. CI only (`test:backup`).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSE_FILE, PROJECT, THIRD_PARTY } from '../config.js';
import { docker } from '../docker.js';
import { BASEBACKUP_ARGS, startOf } from './pgbase.js';
import { dockerStream } from './stream.js';
import { readTar } from './tar.js';
import { STAGED } from './wal.js';

if (process.env.CI !== 'true') throw new Error('pg-archive.int runs in CI only (it creates and removes Docker volumes and containers)');

const id = randomBytes(3).toString('hex');
const volume = `uv-pgarch-${id}`;
const container = `uv-pgarch-${id}`;

/** The postgres service as compose resolves it, with empty env files and stand-in images. */
function resolved(): { user?: string; command: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'uv-pgarch-compose-'));
  try {
    for (const f of ['postgres.env', 'migrate.env', 'api.env', 'worker.env', 'web.env', 'keys.env', 'backup.env']) writeFileSync(join(dir, f), '');
    const stand = Object.fromEntries(['UNIVARSE_API_IMAGE', 'UNIVARSE_WEB_IMAGE', 'UNIVARSE_MIGRATE_IMAGE', 'UNIVARSE_PGBOUNCER_IMAGE'].map((v) => [v, `localhost:5000/x@sha256:${'1'.repeat(64)}`]));
    const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, 'config', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, UNIVARSE_STACK_DIR: dir, ...stand } });
    if (r.status !== 0) throw new Error(`docker compose config failed: ${r.stderr}`);
    const s = (JSON.parse(r.stdout) as { services: Record<string, { user?: string; command: string[] }> }).services.postgres;
    if (!s) throw new Error('no postgres service');
    return s;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const psql = (sql: string) => docker(['exec', '-u', 'postgres', container, 'psql', '-qAt', '-d', 'postgres', '-c', sql]).stdout.trim();

beforeAll(() => {
  const svc = resolved();
  // The archive settings exactly as the stack runs them; TLS and pg_hba need the stack's certificates, so they stay out.
  const settings: string[] = [];
  for (let i = 0; i < svc.command.length; i++)
    if (svc.command[i] === '-c' && /^(archive_|wal_keep_size)/.test(svc.command[i + 1] ?? '')) settings.push('-c', svc.command[i + 1] ?? '');
  expect(settings.filter((s) => s !== '-c').map((s) => s.split('=')[0])).toEqual(['archive_mode', 'archive_command', 'archive_timeout', 'wal_keep_size']);
  docker(['volume', 'create', volume]);
  docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'sh', '-v', `${volume}:/w`, THIRD_PARTY.postgres, '-c', 'chown 999:999 /w && chmod 0700 /w']);
  docker(['run', '-d', '--name', container, '--user', svc.user ?? '999:999', '-e', 'POSTGRES_PASSWORD=ci-only-not-a-secret', '-e', 'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    '-v', `${volume}:/wal-staging`, THIRD_PARTY.postgres, 'postgres', ...settings]);
  for (let i = 0; i < 120; i++) {
    if (docker(['exec', container, 'pg_isready', '-U', 'postgres'], { allowFail: true }).status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}, 180_000);

afterAll(() => {
  docker(['rm', '-f', container], { allowFail: true });
  docker(['volume', 'rm', '-f', volume], { allowFail: true });
});

describe('[B-2] the stack\'s archive_command on its own PostgreSQL 18', () => {
  it('stages a finished segment whole, under its own name, and nothing fails', () => {
    psql('CREATE TABLE t (x int); INSERT INTO t VALUES (1)');
    const segment = psql('SELECT pg_walfile_name(pg_current_wal_lsn())');
    psql('SELECT pg_switch_wal()');
    let listed = '';
    for (let i = 0; i < 60 && !listed.includes(segment); i++) {
      listed = docker(['exec', container, 'ls', '-l', '/wal-staging']).stdout;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    const line = listed.split('\n').find((l) => l.endsWith(segment)) ?? '';
    expect(line).toMatch(/ 16777216 /);
    expect(listed).not.toMatch(/\.part/);
    expect(STAGED.test(segment)).toBe(true);
    expect(psql('SELECT failed_count FROM pg_stat_archiver')).toBe('0');
  });

  it('archiving the same segment again succeeds, and different bytes under its name fail (PostgreSQL keeps it)', () => {
    const cmd = psql("SELECT setting FROM pg_settings WHERE name = 'archive_command'");
    const seg = psql("SELECT name FROM pg_ls_dir('/wal-staging') AS name WHERE name ~ '^[0-9A-F]{24}$' ORDER BY 1 LIMIT 1");
    const run = (p: string) => docker(['exec', '-u', 'postgres', container, 'sh', '-c', cmd.replaceAll('%p', p).replaceAll('%f', seg)], { allowFail: true }).status;
    docker(['exec', '-u', 'postgres', container, 'sh', '-c', `cp /wal-staging/${seg} /tmp/same && cp /wal-staging/${seg} /tmp/other && echo x >> /tmp/other`]);
    expect(run('/tmp/same')).toBe(0);
    expect(run('/tmp/other')).not.toBe(0);
  });
});

describe('[B-3] pg_basebackup with B1\'s arguments', () => {
  it('reports its start point on stderr and carries backup_manifest in the tar stream', async () => {
    psql("CREATE ROLE univarse_backup WITH LOGIN REPLICATION PASSWORD 'ci-only-not-a-secret'");
    let stderr = '';
    const names: string[] = [];
    // Over the image's own socket (its default pg_hba allows local replication); the stack's TLS path is the deploy's.
    const stream = dockerStream(['exec', '-u', 'postgres', container, 'pg_basebackup', '-h', '/var/run/postgresql', '-U', 'univarse_backup', ...BASEBACKUP_ARGS], {
      onStderr: (t) => {
        stderr += t;
      },
    });
    for await (const e of readTar(stream, { maxEntry: 1024 * 1024 * 1024 })) names.push(e.name);
    expect(names).toContain('backup_manifest');
    expect(names).toContain('backup_label');
    expect(startOf(stderr).startWal).toMatch(/^[0-9A-F]{24}$/);
  });
});
