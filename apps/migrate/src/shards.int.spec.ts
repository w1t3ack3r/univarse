/**
 * Spec 0039 Q8, Q9 (S8 PR A): the per-shard runner's real steps, against the development databases. A scratch
 * dedicated database is made by the migrator (which may create databases in development), registered as a READY shard
 * and made to fail its first migration (a type already in its way). The run is recorded FAILED with its fixed code and
 * the shard goes to MAINTENANCE; once the obstacle is gone and Prisma is told the failed migration was rolled back, a
 * retry applies every migration, passes rls:check and returns the shard to READY. Each test removes what it made.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { rlsCheck } from '@univarse/db-ops';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appliedMigrations, realShardSteps } from './real-shards.js';
import { migrateShards } from './shards.js';

const rootEnv = new URL('../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const require = createRequire(import.meta.url);
const PRISMA_CLI = require.resolve('prisma/build/index.js');
const TENANT_PRISMA = fileURLToPath(new URL('../../../packages/db/prisma/tenant', import.meta.url));
const POOL_MIGRATOR = process.env.TENANT_POOL_01_MIGRATOR_URL ?? '';
const PLATFORM_MIGRATOR = process.env.PLATFORM_MIGRATOR_URL ?? '';

let dir = '';
let tenantConfig = '';
const made: { database: string; shardId: string | null }[] = [];

/** A URL to `database` as the migrator, from the pool's. */
const at = (database: string) => POOL_MIGRATOR.replace(/\/univarse_pool_01(?=$|\?)/, `/${database}`);

async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, text: string, values: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, values)).rows;
  } finally {
    await c.end();
  }
}

/** A scratch dedicated database, registered READY on `local`; `obstacle` is SQL run in it first. */
async function scratch(obstacle?: string): Promise<{ name: string; database: string; shardId: string }> {
  const suffix = randomBytes(6).toString('hex');
  const database = `univarse_t_${suffix}`;
  await sql(POOL_MIGRATOR, `CREATE DATABASE ${database} TEMPLATE template0`);
  made.push({ database, shardId: null });
  if (obstacle) await sql(at(database), obstacle);
  const name = `t-${suffix}`;
  const [row] = await sql<{ id: string }>(
    PLATFORM_MIGRATOR,
    `INSERT INTO shard (name, kind, secret_ref, region, server_id, database, capacity, pool_size, status)
     SELECT $1, 'DEDICATED', 'UNUSED_DATABASE_URL', 'local', id, $2, 1, 3, 'READY' FROM db_server WHERE name = 'local' RETURNING id::text`,
    [name, database],
  );
  const shardId = row?.id ?? '';
  const entry = made.find((m) => m.database === database);
  if (entry) entry.shardId = shardId;
  return { name, database, shardId };
}

const env = () => ({ ...process.env, DB_SERVER_LOCAL_MIGRATOR_URL: at('{database}') });
const steps = (only: string) =>
  realShardSteps({ env: env(), platformMigratorUrl: PLATFORM_MIGRATOR, jobId: crypto.randomUUID(), prismaCli: PRISMA_CLI, tenantConfig, only: [only], rlsCheck, log: () => undefined });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uv-shards-'));
  tenantConfig = join(dir, 'tenant.config.mjs');
  writeFileSync(
    tenantConfig,
    `export default { schema: ${JSON.stringify(join(TENANT_PRISMA, 'schema.prisma'))}, migrations: { path: ${JSON.stringify(join(TENANT_PRISMA, 'migrations'))} }, datasource: { url: process.env.TENANT_MIGRATE_URL } };\n`,
  );
});

afterAll(async () => {
  // Runs are kept for every role (a trigger); a test's scratch ones go with their shard, the trigger set aside.
  const ids = made.map((m) => m.shardId).filter((x): x is string => x !== null);
  if (ids.length) {
    const c = new pg.Client({ connectionString: PLATFORM_MIGRATOR });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE migration_run DISABLE TRIGGER migration_run_refuse_delete');
      await c.query('DELETE FROM migration_run WHERE shard_id = ANY($1::uuid[])', [ids]);
      await c.query('ALTER TABLE migration_run ENABLE TRIGGER migration_run_refuse_delete');
      await c.query('DELETE FROM shard WHERE id = ANY($1::uuid[])', [ids]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  }
  for (const m of made) await sql(POOL_MIGRATOR, `DROP DATABASE IF EXISTS ${m.database} WITH (FORCE)`);
  rmSync(dir, { recursive: true, force: true });
});

const runsOf = (shardId: string) =>
  sql<{ status: string; error_code: string | null; applied: number | null; last_migration: string | null; finished_at: Date | null }>(
    PLATFORM_MIGRATOR,
    'SELECT status::text, error_code, applied, last_migration, finished_at FROM migration_run WHERE shard_id = $1::uuid ORDER BY started_at',
    [shardId],
  );
const statusOf = async (shardId: string) => (await sql<{ status: string }>(PLATFORM_MIGRATOR, 'SELECT status::text FROM shard WHERE id = $1::uuid', [shardId]))[0]?.status;

describe('[spec 0039 Q8, Q9] the per-shard runner on real databases', () => {
  it('records a failure, puts the shard in maintenance, and a retry once it is resolved returns it to READY', async () => {
    const s = await scratch(`CREATE TYPE "OrgUnitKind" AS ENUM ('IN_THE_WAY')`);
    const first = await steps(s.name);
    try {
      expect(await migrateShards(first)).toEqual({ migrated: [], failed: [{ name: s.name, code: 'migrate_failed' }] });
    } finally {
      await first.close();
    }
    expect(await statusOf(s.shardId)).toBe('MAINTENANCE');
    expect(await runsOf(s.shardId)).toEqual([expect.objectContaining({ status: 'FAILED', error_code: 'migrate_failed', applied: 0, last_migration: null, finished_at: expect.any(Date) })]);

    // The operator removes the cause and tells Prisma the failed migration was rolled back (its record otherwise
    // blocks every later deploy, P3009); then a retry.
    const url = at(s.database);
    await sql(url, 'DROP TYPE "OrgUnitKind"');
    const [failed] = await sql<{ migration_name: string }>(url, 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL');
    expect(failed?.migration_name).toBe('20260930000000_init');
    const resolve = spawnSync(process.execPath, [PRISMA_CLI, 'migrate', 'resolve', '--rolled-back', failed?.migration_name ?? '', '--config', tenantConfig], {
      env: { ...process.env, TENANT_MIGRATE_URL: url },
      encoding: 'utf8',
    });
    expect(resolve.status).toBe(0);

    const second = await steps(s.name);
    try {
      expect(await migrateShards(second)).toEqual({ migrated: [s.name], failed: [] });
    } finally {
      await second.close();
    }
    const all = await appliedMigrations(url);
    expect(all).not.toBe('unreachable');
    const count = Array.isArray(all) ? all.length : 0;
    expect(count).toBeGreaterThan(10);
    const runs = await runsOf(s.shardId);
    expect(runs[1]).toEqual(expect.objectContaining({ status: 'SUCCEEDED', error_code: null, applied: count, last_migration: Array.isArray(all) ? all.at(-1) : null }));
    expect(await statusOf(s.shardId)).toBe('READY');
  });

  it('a migration that fails partway is NOT rolled back: what ran before the failing statement stays (T38)', async () => {
    // Measured 2026-11-23: Prisma doesn't wrap a PostgreSQL migration in a transaction. The first migration's third
    // statement is in the way; its first two remain. A shard in maintenance may be half-migrated, so its retry needs an
    // operator first (the runbook in 10 §4), and the institutions on it are better closed than served (Q10).
    const s = await scratch(`CREATE TYPE "RecordStatus" AS ENUM ('IN_THE_WAY')`);
    const st = await steps(s.name);
    try {
      expect((await migrateShards(st)).failed).toEqual([{ name: s.name, code: 'migrate_failed' }]);
    } finally {
      await st.close();
    }
    const types = await sql<{ typname: string }>(at(s.database), `SELECT typname FROM pg_type WHERE typname IN ('OrgUnitKind', 'OrgUnitType', 'RecordStatus') ORDER BY typname`);
    expect(types.map((t) => t.typname)).toEqual(['OrgUnitKind', 'OrgUnitType', 'RecordStatus']);
  });

  it('a run ends once and is kept: the trigger refuses a second ending and a delete, for the migrator too', async () => {
    const s = await scratch();
    const [run] = await sql<{ id: string }>(PLATFORM_MIGRATOR, `INSERT INTO migration_run (job_id, shard_id, database) VALUES (gen_random_uuid(), $1::uuid, $2) RETURNING id::text`, [s.shardId, s.database]);
    const id = run?.id ?? '';
    await sql(PLATFORM_MIGRATOR, `UPDATE migration_run SET status = 'SUCCEEDED', finished_at = now(), applied = 0 WHERE id = $1::uuid`, [id]);
    await expect(sql(PLATFORM_MIGRATOR, `UPDATE migration_run SET status = 'FAILED', error_code = 'unexpected' WHERE id = $1::uuid`, [id])).rejects.toThrow(/ends once/);
    await expect(sql(PLATFORM_MIGRATOR, `UPDATE migration_run SET database = 'univarse_platform' WHERE id = $1::uuid`, [id])).rejects.toThrow(/identity/);
    await expect(sql(PLATFORM_MIGRATOR, 'DELETE FROM migration_run WHERE id = $1::uuid', [id])).rejects.toThrow(/kept/);
    // A message is never stored: only a fixed code.
    await expect(
      sql(PLATFORM_MIGRATOR, `INSERT INTO migration_run (job_id, shard_id, database, status, finished_at, error_code) VALUES (gen_random_uuid(), $1::uuid, $2, 'FAILED', now(), 'connection to host 10.0.0.1 refused')`, [s.shardId, s.database]),
    ).rejects.toThrow(/migration_run_error_check/);
  });

  it('the app’s role reads a shard but writes nothing of shards, servers or runs; the checks hold a dedicated name', async () => {
    const app = process.env.PLATFORM_DATABASE_URL ?? '';
    expect((await sql<{ n: string }>(app, `SELECT count(*)::text AS n FROM shard WHERE name = 'pool-01'`))[0]?.n).toBe('1');
    await expect(sql(app, `UPDATE shard SET status = 'MAINTENANCE' WHERE name = 'pool-01'`)).rejects.toThrow(/permission denied/);
    // Of a server, only its id and its templates' prefix (Q4): never its budget, never anything else.
    expect((await sql<{ secret_ref: string }>(app, 'SELECT id, secret_ref FROM db_server')).map((r) => r.secret_ref)).toContain('DB_SERVER_LOCAL');
    await expect(sql(app, 'SELECT max_connections FROM db_server')).rejects.toThrow(/permission denied/);
    await expect(sql(app, 'UPDATE db_server SET secret_ref = secret_ref')).rejects.toThrow(/permission denied/);
    await expect(sql(app, 'SELECT 1 FROM migration_run')).rejects.toThrow(/permission denied/);
    await expect(
      sql(PLATFORM_MIGRATOR, `INSERT INTO shard (name, kind, secret_ref, region, server_id, database, capacity, pool_size) SELECT 'bad', 'DEDICATED', 'X', 'local', id, 'univarse_platform', 1, 3 FROM db_server WHERE name = 'local'`),
    ).rejects.toThrow(/shard_database_check/);
    await expect(
      sql(PLATFORM_MIGRATOR, `INSERT INTO shard (name, kind, secret_ref, region, server_id, database, capacity, pool_size, status) SELECT 'bad', 'POOL', 'X', 'local', id, 'univarse_pool_99', 50, 10, 'READY' FROM db_server WHERE name = 'local'`),
    ).rejects.toThrow(/shard_ready_check/);
  });
});
