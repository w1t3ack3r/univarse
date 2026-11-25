// Spec 0039 Q12: the console's Shards page, read through the console's role. Servers with their connection budget
// (counted as `stack:shards` counts it: @univarse/db's shard-budget), every shard with its institutions, last
// migration run and health, and the warnings (@univarse/domain's shardWarnings). Every column is named: the console's
// role can't read a shard's or a server's `secret_ref`, and nothing here returns a connection string or a variable.
import { Inject, Injectable } from '@nestjs/common';
import type { PlatformShards } from '@univarse/contracts';
import { budgetLeft, dedicatedRoom, MINIMUM_READY, PLATFORM_POOLS, type PlatformClient } from '@univarse/db';
import { shardWarnings, type ShardFacts } from '@univarse/domain';
import { CONSOLE_DB } from '../platform-config.js';

type Shard = PlatformShards['shards'][number];
type Run = NonNullable<Shard['lastRun']>;

/** Pools first; then what needs looking at, then what serves, then what waits; retired last. */
const STATUS_ORDER: Record<string, number> = { MAINTENANCE: 0, ACTIVE: 1, READY: 2, RETIRED: 3 };

interface LastRunRow {
  shard_id: string;
  status: Run['status'];
  applied: number | null;
  last_migration: string | null;
  error_code: Run['errorCode'];
  started_at: Date;
  finished_at: Date | null;
}

@Injectable()
export class PlatformShardsView {
  constructor(@Inject(CONSOLE_DB) private readonly db: PlatformClient) {}

  /** Each shard's latest run, in one statement. */
  async lastRuns(): Promise<Map<string, Run>> {
    const rows = await this.db.$queryRaw<LastRunRow[]>`
      SELECT DISTINCT ON (shard_id) shard_id::text, status::text, applied, last_migration, error_code, started_at, finished_at
        FROM migration_run WHERE shard_id IS NOT NULL ORDER BY shard_id, started_at DESC, id DESC`;
    return new Map(
      rows.map((r) => [
        r.shard_id,
        { status: r.status, applied: r.applied, lastMigration: r.last_migration, errorCode: r.error_code, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null },
      ]),
    );
  }

  async read(now = new Date()): Promise<PlatformShards> {
    const [servers, rows, held, dedicated, runs] = await Promise.all([
      this.db.dbServer.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, region: true, maxConnections: true, reservedConnections: true } }),
      this.db.shard.findMany({
        select: {
          id: true,
          name: true,
          kind: true,
          status: true,
          statusChangedAt: true,
          serverId: true,
          database: true,
          capacity: true,
          poolSize: true,
          health: { select: { ok: true, latencyMs: true, errorCode: true, checkedAt: true, lastSuccessAt: true } },
        },
      }),
      this.db.tenant.groupBy({ by: ['shardId'], where: { status: { not: 'PURGED' } }, _count: { _all: true } }),
      this.db.tenant.findMany({ where: { shard: { kind: 'DEDICATED' }, status: { not: 'PURGED' } }, select: { id: true, slug: true, shortName: true, shardId: true } }),
      this.lastRuns(),
    ]);
    const heldBy = new Map(held.map((h) => [h.shardId, h._count._all]));
    const institutionOf = new Map(dedicated.map((t) => [t.shardId, { id: t.id, slug: t.slug, name: t.shortName }]));
    const serverName = new Map(servers.map((s) => [s.id, s.name]));

    const ordered = [...rows].sort(
      (a, b) =>
        Number(a.status === 'RETIRED') - Number(b.status === 'RETIRED') ||
        Number(a.kind === 'DEDICATED') - Number(b.kind === 'DEDICATED') ||
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        a.name.localeCompare(b.name),
    );
    const facts: ShardFacts[] = ordered.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      statusChangedAt: s.statusChangedAt,
      held: heldBy.get(s.id) ?? 0,
      capacity: s.capacity,
      runErrorCode: runs.get(s.id)?.status === 'FAILED' ? (runs.get(s.id)?.errorCode ?? null) : null,
      health: s.health ? { ok: s.health.ok, checkedAt: s.health.checkedAt, errorCode: s.health.errorCode, lastSuccessAt: s.health.lastSuccessAt } : null,
    }));

    return {
      servers: servers.map((v) => {
        const pools = rows.filter((s) => s.serverId === v.id && s.status !== 'RETIRED').map((s) => s.poolSize);
        const left = budgetLeft({ maxConnections: v.maxConnections, reservedConnections: v.reservedConnections, shardPoolSizes: pools });
        return {
          id: v.id,
          name: v.name,
          region: v.region,
          maxConnections: v.maxConnections,
          reservedConnections: v.reservedConnections,
          platformPools: PLATFORM_POOLS,
          shardPools: pools.reduce((a, b) => a + b, 0),
          left,
          dedicatedRoom: dedicatedRoom(left),
        };
      }),
      shards: ordered.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        status: s.status,
        statusChangedAt: s.statusChangedAt.toISOString(),
        server: serverName.get(s.serverId) ?? '',
        database: s.database,
        capacity: s.capacity,
        poolSize: s.poolSize,
        institutions: heldBy.get(s.id) ?? 0,
        institution: s.kind === 'DEDICATED' ? (institutionOf.get(s.id) ?? null) : null,
        lastRun: runs.get(s.id) ?? null,
        health: s.health
          ? {
              ok: s.health.ok,
              latencyMs: s.health.latencyMs,
              errorCode: s.health.errorCode as NonNullable<Shard['health']>['errorCode'],
              checkedAt: s.health.checkedAt.toISOString(),
              lastSuccessAt: s.health.lastSuccessAt?.toISOString() ?? null,
            }
          : null,
      })),
      ready: rows.filter((s) => s.kind === 'DEDICATED' && s.status === 'READY').length,
      minimumReady: MINIMUM_READY,
      warnings: shardWarnings(facts, MINIMUM_READY, now).map((w) => {
        switch (w.type) {
          case 'maintenance':
            return { ...w, errorCode: w.errorCode as Run['errorCode'], since: w.since.toISOString() };
          case 'unreachable':
            return { ...w, errorCode: w.errorCode as NonNullable<Shard['health']>['errorCode'], lastSuccessAt: w.lastSuccessAt?.toISOString() ?? null };
          case 'unchecked':
            return { ...w, checkedAt: w.checkedAt?.toISOString() ?? null };
          default:
            return w;
        }
      }),
    };
  }
}
