/**
 * Spec 0039 Q5, Q6, Q13, Q-A4 (S8 PR B): `stack:shards`' operations on the development databases. The development
 * migrator stands in for the stack's superuser (it may create databases there). `ready` makes a dedicated database
 * prepared like pool_01, registers it READY, migrates it and reaches it as the app; the drill breaks one and recovers
 * it; `retire` refuses while an institution lives there and drops it once allowed; the budget refuses past its limit.
 * Every database and shard made here is removed at the end.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { rlsCheck } from '@univarse/db-ops';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drill, list, migrateShard, readyOne, retireShard, ShardRefused, type OpsDeps } from './shard-ops.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const require = createRequire(import.meta.url);
const TENANT_PRISMA = fileURLToPath(new URL('../../../packages/db/prisma/tenant', import.meta.url));
const POOL_MIGRATOR = process.env.TENANT_POOL_01_MIGRATOR_URL ?? '';
const POOL_APP = process.env.TENANT_POOL_01_DATABASE_URL ?? '';
const PLATFORM_MIGRATOR = process.env.PLATFORM_MIGRATOR_URL ?? '';
const swap = (url: string, database: string) => url.replace(/\/univarse_pool_01(?=$|\?)/, `/${database}`);

let dir = '';
let deps: OpsDeps;
const made: string[] = [];

async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, text: string, values: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, values)).rows;
  } finally {
    await c.end();
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uv-shard-ops-'));
  const tenantConfig = join(dir, 'tenant.config.mjs');
  writeFileSync(
    tenantConfig,
    `export default { schema: ${JSON.stringify(join(TENANT_PRISMA, 'schema.prisma'))}, migrations: { path: ${JSON.stringify(join(TENANT_PRISMA, 'migrations'))} }, datasource: { url: process.env.TENANT_MIGRATE_URL } };\n`,
  );
  const open = async (database: string) => {
    const c = new pg.Client({ connectionString: swap(POOL_MIGRATOR, database) });
    await c.connect();
    return c;
  };
  deps = {
    env: { ...process.env, DB_SERVER_LOCAL_MIGRATOR_URL: swap(POOL_MIGRATOR, '{database}'), DB_SERVER_LOCAL_APP_URL: swap(POOL_APP, '{database}') },
    platformMigratorUrl: PLATFORM_MIGRATOR,
    admin: () => open('univarse_pool_01'),
    connectAs: open,
    prismaCli: require.resolve('prisma/build/index.js'),
    tenantConfig,
    rlsCheck,
    log: () => undefined,
  };
});

afterAll(async () => {
  const shards = await sql<{ id: string; database: string }>(PLATFORM_MIGRATOR, 'SELECT id::text, database FROM shard WHERE name = ANY($1::text[])', [made]);
  const c = new pg.Client({ connectionString: PLATFORM_MIGRATOR });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE migration_run DISABLE TRIGGER migration_run_refuse_delete');
    await c.query('DELETE FROM migration_run WHERE shard_id = ANY($1::uuid[])', [shards.map((s) => s.id)]);
    await c.query('ALTER TABLE migration_run ENABLE TRIGGER migration_run_refuse_delete');
    await c.query('DELETE FROM shard WHERE id = ANY($1::uuid[])', [shards.map((s) => s.id)]);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
  for (const s of shards) await sql(POOL_MIGRATOR, `DROP DATABASE IF EXISTS ${s.database} WITH (FORCE)`);
  rmSync(dir, { recursive: true, force: true });
});

const shardRow = async (name: string) =>
  (await sql<{ status: string; pool_size: number; kind: string; database: string }>(PLATFORM_MIGRATOR, 'SELECT status::text, pool_size, kind::text, database FROM shard WHERE name = $1', [name]))[0];

describe('[spec 0039 Q5] ready', () => {
  it('makes a dedicated database prepared like pool_01, registers it READY, migrates it and reaches it as the app', async () => {
    const r = await readyOne(deps);
    made.push(r.name);
    expect(r).toMatchObject({ status: 'READY', code: null, reachable: true });
    expect(r.database).toMatch(/^univarse_t_[a-z0-9]{12}$/);
    expect(await shardRow(r.name)).toEqual({ status: 'READY', pool_size: 3, kind: 'DEDICATED', database: r.database });
    const runs = await sql<{ status: string; applied: number }>(PLATFORM_MIGRATOR, 'SELECT status::text, applied FROM migration_run WHERE shard_id = (SELECT id FROM shard WHERE name = $1)', [r.name]);
    expect(runs).toEqual([{ status: 'SUCCEEDED', applied: expect.any(Number) }]);
    // Audited as a host command.
    const audit = await sql<{ n: string }>(PLATFORM_MIGRATOR, `SELECT count(*)::text AS n FROM platform_audit_event WHERE action = 'platform.shard.readied' AND metadata->>'shard' = $1`, [r.name]);
    expect(audit[0]?.n).toBe('1');
    // The same privileges as pool_01: CONNECT for the app alone, its table rights, and RLS on every table.
    const privileges = async (database: string) =>
      (
        await sql<{ connect: boolean; platform: boolean; tables: boolean; usage: boolean }>(
          swap(POOL_MIGRATOR, database),
          `SELECT has_database_privilege('univarse_app', current_database(), 'CONNECT') AS connect,
                  has_database_privilege('univarse_app', 'univarse_platform', 'CONNECT') AS platform,
                  has_table_privilege('univarse_app', 'user_account', 'SELECT, INSERT, UPDATE, DELETE') AS tables,
                  has_schema_privilege('univarse_app', 'public', 'USAGE') AS usage`,
        )
      )[0];
    expect(await privileges(r.database)).toEqual(await privileges('univarse_pool_01'));
    expect(await privileges(r.database)).toEqual({ connect: true, platform: false, tables: true, usage: true });
    // Nobody else may connect: PUBLIC holds nothing on it.
    const publicAcl = await sql<{ ok: boolean }>(POOL_MIGRATOR, `SELECT has_database_privilege('public', $1, 'CONNECT') AS ok`, [r.database]);
    expect(publicAcl[0]?.ok).toBe(false);
    expect((await rlsCheck({ tenantMigratorUrl: swap(POOL_MIGRATOR, r.database), platformMigratorUrl: PLATFORM_MIGRATOR })).problems).toEqual([]);
  });

  it('is refused past the connection budget, before anything is created', async () => {
    const before = await sql<{ n: string }>(POOL_MIGRATOR, `SELECT count(*)::text AS n FROM pg_database WHERE datname LIKE 'univarse_t_%'`);
    const [server] = await sql<{ max_connections: number; reserved_connections: number }>(PLATFORM_MIGRATOR, `SELECT max_connections, reserved_connections FROM db_server WHERE name = 'local'`);
    // The boundary: exactly 2 connections left, one short of a dedicated database's pool of 3.
    const { left } = await list(deps);
    await sql(PLATFORM_MIGRATOR, `UPDATE db_server SET reserved_connections = reserved_connections + $1 WHERE name = 'local'`, [left - 2]);
    try {
      expect((await list(deps)).left).toBe(2);
      await expect(readyOne(deps)).rejects.toThrow(/2 connection\(s\) left, a dedicated database needs 3/);
      await expect(readyOne(deps)).rejects.toBeInstanceOf(ShardRefused);
    } finally {
      await sql(PLATFORM_MIGRATOR, `UPDATE db_server SET reserved_connections = $1 WHERE name = 'local'`, [server?.reserved_connections]);
    }
    expect(await sql<{ n: string }>(POOL_MIGRATOR, `SELECT count(*)::text AS n FROM pg_database WHERE datname LIKE 'univarse_t_%'`)).toEqual(before);
  });
});

describe('[spec 0039 Q-A4] the drill, and migrate', () => {
  it('the drill breaks a new database’s first migration, shows it in maintenance, settles it and brings it back to READY', async () => {
    const r = await drill(deps);
    made.push(r.name);
    expect(r).toEqual({ name: r.name, failedWith: 'migrate_failed', recovered: true });
    expect((await shardRow(r.name))?.status).toBe('READY');
    const runs = await sql<{ status: string; error_code: string | null }>(PLATFORM_MIGRATOR, 'SELECT status::text, error_code FROM migration_run WHERE shard_id = (SELECT id FROM shard WHERE name = $1) ORDER BY started_at', [r.name]);
    expect(runs).toEqual([
      { status: 'FAILED', error_code: 'migrate_failed' },
      { status: 'SUCCEEDED', error_code: null },
    ]);
  });

  it('migrate refuses an unknown shard and a malformed migration name; on a healthy shard it simply runs', async () => {
    await expect(migrateShard(deps, 't-nonexistent0')).rejects.toThrow(/no shard has this name/);
    await expect(migrateShard(deps, made[0] ?? '', { as: 'applied', migration: 'drop table x' })).rejects.toThrow(/not a migration name/);
    expect(await migrateShard(deps, made[0] ?? '')).toEqual({ ok: true, code: null });
  });
});

describe('[spec 0039 Q13] retire', () => {
  it('refuses while an institution lives there, refuses a pool, and drops a database that has none', async () => {
    const r = await readyOne(deps);
    made.push(r.name);
    const [shard] = await sql<{ id: string }>(PLATFORM_MIGRATOR, 'SELECT id::text FROM shard WHERE name = $1', [r.name]);
    const slug = `prg-${r.name.slice(2)}`;
    const [t] = await sql<{ id: string }>(
      PLATFORM_MIGRATOR,
      `INSERT INTO tenant (slug, legal_name, short_name, type, ownership, status, shard_id, tier, updated_at) VALUES ($1, 'Retiring College', 'RC', 'POLYTECHNIC', 'STATE', 'ARCHIVED', $2::uuid, 'DEDICATED', now()) RETURNING id::text`,
      [slug, shard?.id],
    );
    try {
      await expect(retireShard(deps, r.name, new Date())).rejects.toThrow(/not purged/);
    } finally {
      await sql(PLATFORM_MIGRATOR, 'DELETE FROM tenant WHERE id = $1::uuid', [t?.id]);
    }
    await expect(retireShard(deps, 'pool-01', new Date())).rejects.toThrow(/a pool is not/);
    expect(await retireShard(deps, r.name, null)).toEqual({ database: r.database, institutions: 0 });
    expect((await shardRow(r.name))?.status).toBe('RETIRED');
    expect(await sql(POOL_MIGRATOR, 'SELECT 1 FROM pg_database WHERE datname = $1', [r.database])).toEqual([]);
    await expect(retireShard(deps, r.name, null)).rejects.toThrow(/already retired/);
  });
});

describe('[spec 0039 Q5, Q6] list', () => {
  it('names every shard with its status and last run, and the budget', async () => {
    const l = await list(deps);
    expect(l.server).toBe('local');
    expect(l.left).toBeGreaterThanOrEqual(0);
    expect(l.shards.find((s) => s.name === 'pool-01')).toMatchObject({ kind: 'POOL', status: 'ACTIVE' });
    expect(l.shards.find((s) => s.name === made[0])).toMatchObject({ kind: 'DEDICATED', status: 'READY', lastRun: 'SUCCEEDED' });
  });
});

describe('[spec 0039 PR B] PgBouncer’s fallback reaches only granted databases', () => {
  // CI bootstraps a fresh database every run; a development database made before this change keeps the old default
  // until its bootstrap runs again (it needs the superuser), so this runs in CI.
  it.runIf(process.env.CI === 'true')('no role may connect to postgres or template1 through PUBLIC', async () => {
    const rows = await sql<{ datname: string; ok: boolean }>(
      POOL_MIGRATOR,
      `SELECT datname, has_database_privilege('univarse_app', datname, 'CONNECT') AS ok FROM pg_database WHERE datname IN ('postgres', 'template1') ORDER BY datname`,
    );
    expect(rows).toEqual([
      { datname: 'postgres', ok: false },
      { datname: 'template1', ok: false },
    ]);
  });
});

