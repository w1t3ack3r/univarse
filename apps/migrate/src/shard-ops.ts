// Spec 0039 Q5, Q6, Q13, Q-A4 (S8 PR B): what `pnpm stack:shards` does, inside the `shards` job (the migrate image).
//   ready [--count n]      the budget checked, then each new dedicated database created, prepared, registered READY,
//                          migrated through the per-shard runner and reached through PgBouncer as the app's role
//   migrate <shard> [--applied <m> | --rolled-back <m>]
//                          a failed migration settled (only as the operator says), then that shard's run
//   retire <shard> --confirm <shard> --backup-after <ISO time>
//                          a dedicated database whose institutions are all purged (or that had none), dropped once a
//                          backup set is newer than its last purge, then RETIRED
//   drill                  criterion 9's migration drill (a shard made to fail, then recovered)
//   list                   each server's budget and each shard
// Every change is audited on the platform as a host command. Nothing printed carries a URL or a secret.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { writePlatformAudit } from '@univarse/crypto';
import { createPlatformClient, shardUrl, type PlatformClient } from '@univarse/db';
import { createDedicatedDatabase, dropDedicatedDatabase } from '@univarse/db-ops';
import { prismaTenant, realShardSteps, type Env } from './real-shards.js';
import { migrateShards, type RunErrorCode } from './shards.js';

/** Spec 0039 Q6: PgBouncer's pools on the platform database (the API's, the console's and the relay's roles, 10 each). */
export const PLATFORM_POOLS = 30;
/** Q3: a dedicated database's PgBouncer pool (its fallback entry's pool_size). */
export const DEDICATED_POOL_SIZE = 3;
/** Q5: below this many READY dedicated databases, the deploy and `list` warn. */
export const MINIMUM_READY = 2;

/** Q6: the connections a server has left for new shards. Pure. */
export function budgetLeft(s: { maxConnections: number; reservedConnections: number; shardPoolSizes: readonly number[] }): number {
  return s.maxConnections - s.reservedConnections - PLATFORM_POOLS - s.shardPoolSizes.reduce((a, b) => a + b, 0);
}

/** Q6: how many dedicated databases a budget holds. */
export const dedicatedRoom = (left: number): number => Math.max(0, Math.floor(left / DEDICATED_POOL_SIZE));

/** Q5: the deploy's warning when too few dedicated databases are ready, or null. Pure. */
export function readyWarning(ready: number): string | null {
  return ready >= MINIMUM_READY ? null : `only ${String(ready)} dedicated database(s) ready; keep ${String(MINIMUM_READY)}: pnpm stack:shards ready --count ${String(MINIMUM_READY - ready)}`;
}

export class ShardRefused extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = 'ShardRefused';
  }
}

export interface OpsDeps {
  readonly env: Env;
  readonly platformMigratorUrl: string;
  /** Creates and drops databases: the superuser on the stack; the development migrator in tests. */
  readonly admin: () => Promise<pg.Client>;
  /** Opens a database as the same identity as `admin`. */
  readonly connectAs: (database: string) => Promise<pg.Client>;
  readonly prismaCli: string;
  readonly tenantConfig: string;
  readonly rlsCheck: (urls: { tenantMigratorUrl: string; platformMigratorUrl: string }) => Promise<{ problems: string[] }>;
  readonly log: (line: string) => void;
}

interface ServerRow {
  id: string;
  name: string;
  maxConnections: number;
  reservedConnections: number;
  secretRef: string;
}

async function localServer(p: PlatformClient): Promise<ServerRow> {
  return p.dbServer.findUniqueOrThrow({ where: { name: 'local' }, select: { id: true, name: true, maxConnections: true, reservedConnections: true, secretRef: true } });
}

async function serverBudget(p: PlatformClient, serverId: string, s: ServerRow): Promise<number> {
  const shards = await p.shard.findMany({ where: { serverId, status: { not: 'RETIRED' } }, select: { poolSize: true } });
  return budgetLeft({ maxConnections: s.maxConnections, reservedConnections: s.reservedConnections, shardPoolSizes: shards.map((x) => x.poolSize) });
}

/** Runs the per-shard runner on one shard (by name); its outcome. */
async function migrateOne(d: OpsDeps, name: string): Promise<{ ok: boolean; code: RunErrorCode | null }> {
  const steps = await realShardSteps({
    env: d.env,
    platformMigratorUrl: d.platformMigratorUrl,
    jobId: crypto.randomUUID(),
    prismaCli: d.prismaCli,
    tenantConfig: d.tenantConfig,
    only: [name],
    rlsCheck: d.rlsCheck,
    log: d.log,
  });
  try {
    const r = await migrateShards(steps);
    const failed = r.failed.find((f) => f.name === name);
    if (failed) return { ok: false, code: failed.code };
    if (!r.migrated.includes(name)) return { ok: false, code: 'unexpected' };
    return { ok: true, code: null };
  } finally {
    await steps.close();
  }
}

/** Q5: proves the database is reachable as the API will reach it: through PgBouncer, as the app's role. */
async function reachAsApp(d: OpsDeps, s: { name: string; database: string; serverRef: string }): Promise<boolean> {
  const r = shardUrl({ name: s.name, kind: 'DEDICATED', secretRef: 'UNUSED_DATABASE_URL', database: s.database, server: { secretRef: s.serverRef } }, 'app', d.env);
  if ('problem' in r) return false;
  const c = new pg.Client({ connectionString: r.url, connectionTimeoutMillis: 10_000 });
  try {
    await c.connect();
    await c.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => undefined);
  }
}

export interface ReadyResult {
  readonly name: string;
  readonly database: string;
  readonly status: 'READY' | 'MAINTENANCE';
  readonly code: RunErrorCode | null;
  readonly reachable: boolean;
}

/** Q5: one new dedicated database; `obstacle` (the drill only) is SQL run in it before its first migration. */
export async function readyOne(d: OpsDeps, opts: { obstacle?: string } = {}): Promise<ReadyResult> {
  const p = createPlatformClient(d.platformMigratorUrl);
  try {
    const server = await localServer(p);
    const left = await serverBudget(p, server.id, server);
    if (left < DEDICATED_POOL_SIZE) throw new ShardRefused(`the server's connection budget is spent: ${String(Math.max(left, 0))} connection(s) left, a dedicated database needs ${String(DEDICATED_POOL_SIZE)}`);
    const suffix = randomBytes(6).toString('hex');
    const database = `univarse_t_${suffix}`;
    const name = `t-${suffix}`;
    const admin = await d.admin();
    try {
      await createDedicatedDatabase(admin, d.connectAs, database);
      if (opts.obstacle) {
        const c = await d.connectAs(database);
        try {
          await c.query(opts.obstacle);
        } finally {
          await c.end();
        }
      }
      await p.$transaction(async (tx) => {
        await tx.shard.create({
          data: { name, kind: 'DEDICATED', secretRef: 'UNUSED_DATABASE_URL', region: 'local', serverId: server.id, database, capacity: 1, poolSize: DEDICATED_POOL_SIZE, status: 'READY' },
          select: { id: true },
        });
        await writePlatformAudit(tx, { actorId: null, action: 'platform.shard.readied', tenantId: null, metadata: { shard: name, database, server: server.name, poolSize: DEDICATED_POOL_SIZE } });
      });
    } catch (e) {
      // Nothing registered: the database goes too, so no unregistered database is left behind.
      if (!(await p.shard.findUnique({ where: { name }, select: { id: true } }))) await dropDedicatedDatabase(admin, database).catch(() => undefined);
      throw e;
    } finally {
      await admin.end();
    }
    const run = await migrateOne(d, name);
    const reachable = run.ok ? await reachAsApp(d, { name, database, serverRef: server.secretRef }) : false;
    return { name, database, status: run.ok ? 'READY' : 'MAINTENANCE', code: run.code, reachable };
  } finally {
    await p.$disconnect();
  }
}

/** Q-A4: settles a failed migration, as the operator says, then runs the shard's migrations. */
export async function migrateShard(d: OpsDeps, name: string, resolve?: { as: 'applied' | 'rolled-back'; migration: string }): Promise<{ ok: boolean; code: RunErrorCode | null }> {
  const p = createPlatformClient(d.platformMigratorUrl);
  try {
    const s = await p.shard.findUnique({ where: { name }, select: { id: true, kind: true, secretRef: true, database: true, status: true, server: { select: { secretRef: true } } } });
    if (!s) throw new ShardRefused('no shard has this name');
    if (s.status === 'RETIRED') throw new ShardRefused('the shard is retired');
    if (resolve) {
      if (!/^[0-9]{14}_[a-z0-9_]{1,80}$/.test(resolve.migration)) throw new ShardRefused('not a migration name');
      const r = shardUrl({ name, kind: s.kind, secretRef: s.secretRef, database: s.database, server: s.server }, 'migrator', d.env);
      if ('problem' in r) throw new ShardRefused(`no migrator URL for it (${r.problem})`);
      await prismaTenant(d, 'resolve', r.url, [`--${resolve.as}`, resolve.migration]);
      await p.$transaction((tx) => writePlatformAudit(tx, { actorId: null, action: 'platform.shard.migration_resolved', tenantId: null, metadata: { shard: name, migration: resolve.migration, as: resolve.as } }));
    }
    return await migrateOne(d, name);
  } finally {
    await p.$disconnect();
  }
}

/**
 * Q13: why a dedicated database may not be dropped yet, or null when it may. Every institution on it is purged (its
 * certificate written), or it never had one; and a complete backup set is newer than the last of those purges, so no
 * set taken before the purge is the only copy of what the purge left. Pure.
 */
export function retireProblem(tenants: readonly { status: string; purgedAt: Date | null }[], backupAfter: Date | null): string | null {
  if (tenants.some((t) => t.status !== 'PURGED')) return 'an institution on it is not purged';
  if (tenants.some((t) => t.purgedAt === null)) return 'a purge on it has not finished';
  const last = tenants.reduce<Date | null>((a, t) => (t.purgedAt && (!a || t.purgedAt > a) ? t.purgedAt : a), null);
  if (last && (!backupAfter || backupAfter <= last)) return 'no backup set is newer than its last purge: take one first (pnpm stack:backup)';
  return null;
}

/**
 * Q13: drops a dedicated database whose every institution is purged (or that never had one), once a backup set newer
 * than its last purge exists (`backupAfter`, from the host), then RETIRED and audited.
 */
export async function retireShard(d: OpsDeps, name: string, backupAfter: Date | null): Promise<{ database: string; institutions: number }> {
  const p = createPlatformClient(d.platformMigratorUrl);
  try {
    const s = await p.shard.findUnique({ where: { name }, select: { id: true, kind: true, database: true, status: true, tenants: { select: { status: true, purge: { select: { certificateAt: true } } } } } });
    if (!s) throw new ShardRefused('no shard has this name');
    if (s.kind !== 'DEDICATED') throw new ShardRefused('only a dedicated database is retired; a pool is not');
    if (s.status === 'RETIRED') throw new ShardRefused('the shard is already retired');
    const problem = retireProblem(s.tenants.map((t) => ({ status: t.status, purgedAt: t.purge?.certificateAt ?? null })), backupAfter);
    if (problem) throw new ShardRefused(problem);
    const admin = await d.admin();
    try {
      await dropDedicatedDatabase(admin, s.database);
    } finally {
      await admin.end();
    }
    await p.$transaction(async (tx) => {
      await tx.shard.update({ where: { id: s.id }, data: { status: 'RETIRED', statusChangedAt: new Date() }, select: { id: true } });
      await writePlatformAudit(tx, { actorId: null, action: 'platform.shard.retired', tenantId: null, metadata: { shard: name, database: s.database, institutions: s.tenants.length } });
    });
    return { database: s.database, institutions: s.tenants.length };
  } finally {
    await p.$disconnect();
  }
}

/** Criterion 9's drill: a database whose first migration is in the way, shown in maintenance, then recovered. */
export const DRILL_OBSTACLE = `CREATE TYPE "OrgUnitKind" AS ENUM ('DRILL_IN_THE_WAY')`;
export const DRILL_FIRST_MIGRATION = '20260930000000_init';

export async function drill(d: OpsDeps): Promise<{ name: string; failedWith: RunErrorCode | null; recovered: boolean }> {
  const broken = await readyOne(d, { obstacle: DRILL_OBSTACLE });
  d.log(`[shards] drill: ${broken.name} failed its first migration (${broken.code ?? 'none'}); it is in ${broken.status}`);
  if (broken.status !== 'MAINTENANCE') return { name: broken.name, failedWith: null, recovered: false };
  const c = await d.connectAs(broken.database);
  try {
    await c.query('DROP TYPE "OrgUnitKind"');
  } finally {
    await c.end();
  }
  const r = await migrateShard(d, broken.name, { as: 'rolled-back', migration: DRILL_FIRST_MIGRATION });
  return { name: broken.name, failedWith: broken.code, recovered: r.ok };
}

export interface ShardListing {
  readonly server: string;
  readonly left: number;
  readonly room: number;
  readonly ready: number;
  readonly shards: readonly { name: string; kind: string; status: string; institutions: number; lastRun: string | null }[];
}

/** Q5, Q6: the budget and the shards, with the last run of each. */
export async function list(d: Pick<OpsDeps, 'platformMigratorUrl'>): Promise<ShardListing> {
  const p = createPlatformClient(d.platformMigratorUrl);
  try {
    const server = await localServer(p);
    const left = await serverBudget(p, server.id, server);
    const shards = await p.shard.findMany({
      where: { serverId: server.id },
      orderBy: [{ kind: 'desc' }, { name: 'asc' }],
      select: { name: true, kind: true, status: true, _count: { select: { tenants: true } }, migrationRuns: { orderBy: { startedAt: 'desc' }, take: 1, select: { status: true, errorCode: true } } },
    });
    return {
      server: server.name,
      left,
      room: dedicatedRoom(left),
      ready: shards.filter((s) => s.kind === 'DEDICATED' && s.status === 'READY').length,
      shards: shards.map((s) => {
        const run = s.migrationRuns[0];
        return { name: s.name, kind: s.kind, status: s.status, institutions: s._count.tenants, lastRun: run ? `${run.status}${run.errorCode ? ` (${run.errorCode})` : ''}` : null };
      }),
    };
  } finally {
    await p.$disconnect();
  }
}
