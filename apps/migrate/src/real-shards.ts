// Spec 0039 Q4, Q8, Q9: the migrate job's real per-shard steps, on PostgreSQL. The platform is read and written as the
// migrator (the tables' owner: only it writes shards and runs, Q15); each shard is reached by its migrator URL from the
// environment (Q4). A Prisma CLI run's output names hosts and databases, never passwords; nothing here logs a URL.
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { shardUrl, type ShardAddress } from '@univarse/db';
import type { RunOutcome, ShardStatus, ShardSteps, ShardToMigrate } from './shards.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface RealShardOptions {
  readonly env: Env;
  /** The platform database as the migrator. */
  readonly platformMigratorUrl: string;
  /** One id for every run this job records, the platform's included. */
  readonly jobId: string;
  /** `prisma migrate <command> --config <tenantConfig>` with TENANT_MIGRATE_URL set (the Prisma CLI's entry point). */
  readonly prismaCli: string;
  readonly tenantConfig: string;
  /** Only these shards, by name (tests); every listed shard otherwise. */
  readonly only?: readonly string[];
  /** rls:check on one tenant database (db-ops' rlsCheck, injected so this file has no circular import). */
  readonly rlsCheck: (urls: { tenantMigratorUrl: string; platformMigratorUrl: string }) => Promise<{ problems: string[] }>;
  readonly log: (line: string) => void;
}

/** The release's commit from the image's version (`sha-<hex>`), or null in development. */
export function commitFrom(version: string | undefined): string | null {
  const m = /^sha-([0-9a-f]{7,40})$/.exec(version ?? '');
  return m?.[1] ?? null;
}

const UNDEFINED_TABLE = '42P01';

/** The migrations applied on a database, in order, or 'unreachable'. A database never migrated has none. */
export async function appliedMigrations(url: string): Promise<readonly string[] | 'unreachable'> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await c.connect();
  } catch {
    return 'unreachable';
  }
  try {
    const r = await c.query<{ migration_name: string }>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at, migration_name',
    );
    return r.rows.map((x) => x.migration_name);
  } catch (e) {
    if ((e as { code?: string }).code === UNDEFINED_TABLE) return [];
    throw e;
  } finally {
    await c.end();
  }
}

/** `prisma migrate <command>` for one tenant database; rejects on a non-zero exit. Its output is shown. */
export function prismaTenant(o: Pick<RealShardOptions, 'prismaCli' | 'tenantConfig'>, command: 'deploy' | 'status' | 'resolve', url: string, extra: readonly string[] = []): Promise<void> {
  const r = spawnSync(process.execPath, [o.prismaCli, 'migrate', command, ...extra, '--config', o.tenantConfig], {
    stdio: 'inherit',
    env: { ...process.env, TENANT_MIGRATE_URL: url, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  if (r.status !== 0) return Promise.reject(new Error(`prisma migrate ${command} exited ${String(r.status ?? r.signal)}`));
  return Promise.resolve();
}

interface ShardRowSql {
  id: string;
  name: string;
  kind: 'POOL' | 'DEDICATED';
  secret_ref: string;
  database: string;
  status: ShardStatus;
  server_ref: string;
  has_tenant: boolean;
}

/** The real steps, on one platform connection the caller closes with `close()`. */
export async function realShardSteps(o: RealShardOptions): Promise<ShardSteps & { close(): Promise<void>; jobId: string; address(s: ShardToMigrate): ShardAddress | undefined }> {
  const platform = new pg.Client({ connectionString: o.platformMigratorUrl });
  await platform.connect();
  const jobId = o.jobId;
  const commit = commitFrom(o.env.UNIVARSE_VERSION);
  const addresses = new Map<string, ShardAddress>();

  return {
    jobId,
    address: (s) => addresses.get(s.id),
    close: () => platform.end(),
    log: o.log,
    async listShards() {
      const r = await platform.query<ShardRowSql>(
        `SELECT s.id::text, s.name, s.kind::text AS kind, s.secret_ref, s.database, s.status::text AS status, d.secret_ref AS server_ref,
                EXISTS (SELECT 1 FROM tenant t WHERE t.shard_id = s.id) AS has_tenant
           FROM shard s JOIN db_server d ON d.id = s.server_id
          WHERE s.status IN ('ACTIVE', 'MAINTENANCE', 'READY')
          ORDER BY (s.kind <> 'POOL'), s.name`,
      );
      const rows = o.only ? r.rows.filter((x) => o.only?.includes(x.name)) : r.rows;
      for (const x of rows) addresses.set(x.id, { name: x.name, kind: x.kind, secretRef: x.secret_ref, database: x.database, server: { secretRef: x.server_ref } });
      return rows.map((x) => ({ id: x.id, name: x.name, kind: x.kind, database: x.database, status: x.status, hasTenant: x.has_tenant }));
    },
    migratorUrl(shard) {
      const a = addresses.get(shard.id);
      if (!a) return null;
      const r = shardUrl(a, 'migrator', o.env);
      return 'url' in r ? r.url : null;
    },
    async startRun(shard) {
      const r = await platform.query<{ id: string }>(
        'INSERT INTO migration_run (job_id, commit, shard_id, database) VALUES ($1::uuid, $2, $3::uuid, $4) RETURNING id::text',
        [jobId, commit, shard.id, shard.database],
      );
      return r.rows[0]?.id ?? '';
    },
    async finishRun(runId, outcome: RunOutcome) {
      await platform.query(
        `UPDATE migration_run SET status = $2::"MigrationRunStatus", finished_at = now(), applied = $3, last_migration = $4, error_code = $5
          WHERE id = $1::uuid`,
        [runId, outcome.status, outcome.applied, outcome.lastMigration, outcome.status === 'FAILED' ? outcome.code : null],
      );
    },
    applied: appliedMigrations,
    migrate: (url) => prismaTenant(o, 'deploy', url),
    async rlsCheck(url) {
      return (await o.rlsCheck({ tenantMigratorUrl: url, platformMigratorUrl: o.platformMigratorUrl })).problems;
    },
    async setStatus(shardId, status) {
      await platform.query('UPDATE shard SET status = $2::"ShardStatus", status_changed_at = now() WHERE id = $1::uuid', [shardId, status]);
    },
  };
}

/**
 * Q8: the platform's own run, recorded once its migrations are done (the table is created by them on the first
 * deploy, so it can't be written before). A failure is recorded if the table exists; the error is thrown either way.
 */
export async function recordPlatformRun(
  platformMigratorUrl: string,
  run: { jobId: string; commit: string | null; database: string; startedAt: Date; outcome: RunOutcome },
): Promise<void> {
  const c = new pg.Client({ connectionString: platformMigratorUrl });
  await c.connect();
  try {
    const code = run.outcome.status === 'FAILED' ? run.outcome.code : null;
    await c.query(
      `INSERT INTO migration_run (job_id, commit, shard_id, database, status, started_at, finished_at, applied, last_migration, error_code)
       VALUES ($1::uuid, $2, NULL, $3, $4::"MigrationRunStatus", $5, now(), $6, $7, $8)`,
      [run.jobId, run.commit, run.database, run.outcome.status, run.startedAt, run.outcome.applied, run.outcome.lastMigration, code],
    );
  } finally {
    await c.end();
  }
}

/** The database name in a URL's path. */
export function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}
