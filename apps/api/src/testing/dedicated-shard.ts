// Spec 0039 PR C: a real dedicated database for the integration tests, made as `pnpm stack:shards ready` makes one:
// created and prepared by db-ops' `createDedicatedDatabase`, migrated by the Prisma CLI with the tenant migrations,
// checked by `rls:check`, and registered READY on the platform. On development's server the migrator may create
// databases (db:setup's CREATEDB, development only); on Q14's second server the admin is that server's superuser.
// Removed with `dropDedicatedShard`: its database dropped, its platform rows deleted.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDedicatedDatabase, dropDedicatedDatabase, rlsCheck } from '@univarse/db-ops';
import pg from 'pg';

const DB_PACKAGE = fileURLToPath(new URL('../../../../packages/db/package.json', import.meta.url));
const TENANT_PRISMA = fileURLToPath(
  new URL('../../../../packages/db/prisma/tenant', import.meta.url),
);

/** pool_01's URL with another database in its place (development's URLs end in `/univarse_pool_01`). */
export const swapDatabase = (url: string, database: string) =>
  url.replace(/\/univarse_pool_01(?=$|\?)/, `/${database}`);

/**
 * The `local` server's two URL templates (Q4), derived from pool_01's when the environment has none: an `.env` made
 * before PR C has none, and `pnpm db:setup` writes them since.
 */
export function useLocalTemplates(env: NodeJS.ProcessEnv = process.env): void {
  env.DB_SERVER_LOCAL_APP_URL ??= swapDatabase(env.TENANT_POOL_01_DATABASE_URL ?? '', '{database}');
  env.DB_SERVER_LOCAL_MIGRATOR_URL ??= swapDatabase(
    env.TENANT_POOL_01_MIGRATOR_URL ?? '',
    '{database}',
  );
}

/** A server the tests make databases on. */
export interface TestServer {
  /** Its `db_server` row's name. */
  readonly name: string;
  /** The migrator's URL template there, `{database}` as its whole path. */
  readonly migratorTemplate: string;
  /** A connection that may create and drop databases there, to the given database. */
  readonly admin: (database: string) => Promise<pg.Client>;
}

/** Development's server, as the migrator. */
export function localServer(env: NodeJS.ProcessEnv = process.env): TestServer {
  useLocalTemplates(env);
  const migratorTemplate = env.DB_SERVER_LOCAL_MIGRATOR_URL ?? '';
  return {
    name: 'local',
    migratorTemplate,
    admin: async (database) => {
      const c = new pg.Client({
        connectionString: migratorTemplate.replace('{database}', database),
      });
      await c.connect();
      return c;
    },
  };
}

export interface DedicatedShard {
  readonly id: string;
  readonly name: string;
  readonly database: string;
  readonly server: TestServer;
  /** The migrator's URL to it. */
  readonly migratorUrl: string;
}

async function platformQuery<T extends pg.QueryResultRow>(
  platformMigratorUrl: string,
  text: string,
  values: unknown[],
): Promise<T[]> {
  const c = new pg.Client({ connectionString: platformMigratorUrl });
  await c.connect();
  try {
    return (await c.query<T>(text, values)).rows;
  } finally {
    await c.end();
  }
}

/**
 * A dedicated database, created, migrated, `rls:check`ed and registered with `status` (READY, as `stack:shards ready`
 * leaves it; ACTIVE for a test that places an institution on it as the migrator, as a claim leaves it).
 */
export async function readyDedicatedShard(
  server: TestServer,
  platformMigratorUrl: string,
  status: 'READY' | 'ACTIVE' = 'READY',
): Promise<DedicatedShard> {
  const suffix = randomBytes(6).toString('hex');
  const database = `univarse_t_${suffix}`;
  const admin = await server.admin('postgres');
  try {
    await createDedicatedDatabase(admin, (d) => server.admin(d), database);
  } finally {
    await admin.end();
  }
  const migratorUrl = server.migratorTemplate.replace('{database}', database);
  const dir = mkdtempSync(join(tmpdir(), 'uv-dedicated-'));
  try {
    const config = join(dir, 'tenant.config.mjs');
    writeFileSync(
      config,
      `export default { schema: ${JSON.stringify(join(TENANT_PRISMA, 'schema.prisma'))}, migrations: { path: ${JSON.stringify(join(TENANT_PRISMA, 'migrations'))} }, datasource: { url: process.env.TENANT_MIGRATE_URL } };\n`,
    );
    const prisma = createRequire(DB_PACKAGE).resolve('prisma/build/index.js');
    const r = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--config', config], {
      stdio: 'pipe',
      env: {
        ...process.env,
        TENANT_MIGRATE_URL: migratorUrl,
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
    });
    if (r.status !== 0)
      throw new Error(`prisma migrate deploy exited ${String(r.status ?? r.signal)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const check = await rlsCheck({ tenantMigratorUrl: migratorUrl, platformMigratorUrl });
  if (check.problems.length > 0)
    throw new Error(`rls:check on ${database}: ${check.problems.join('; ')}`);
  const [row] = await platformQuery<{ id: string }>(
    platformMigratorUrl,
    `INSERT INTO shard (name, kind, secret_ref, region, server_id, database, capacity, pool_size, status)
     SELECT $1, 'DEDICATED', 'UNUSED_DATABASE_URL', region, id, $2, 1, 3, $4::"ShardStatus" FROM db_server WHERE name = $3 RETURNING id::text`,
    [`t-${suffix}`, database, server.name, status],
  );
  if (!row) throw new Error(`no db_server named ${server.name}`);
  return { id: row.id, name: `t-${suffix}`, database, server, migratorUrl };
}

/** Drops the database and deletes the shard's row (its institutions removed first; it has no migration runs). */
export async function dropDedicatedShard(
  s: DedicatedShard,
  platformMigratorUrl: string,
): Promise<void> {
  const admin = await s.server.admin('postgres');
  try {
    await dropDedicatedDatabase(admin, s.database);
  } finally {
    await admin.end();
  }
  await platformQuery(platformMigratorUrl, 'DELETE FROM shard WHERE id = $1::uuid', [s.id]);
}
