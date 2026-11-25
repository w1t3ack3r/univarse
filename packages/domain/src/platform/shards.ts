/**
 * Spec 0039 Q12: what the console's Shards page warns about. Pure, so each edge is tested without a database: a pool
 * nearly full, too few ready dedicated databases, a shard in maintenance, one unreachable, and one the worker hasn't
 * checked lately (its health pass isn't running). A retired shard never warns.
 */

/** A pool at this share of its capacity or more is nearly full. */
export const POOL_NEARLY_FULL = 0.8;
/** Q11: the worker checks every minute; a check older than three of its passes means the pass isn't running. */
export const HEALTH_STALE_MS = 3 * 60_000;

export type ShardKindName = 'POOL' | 'DEDICATED';
export type ShardStatusName = 'READY' | 'ACTIVE' | 'MAINTENANCE' | 'RETIRED';

export interface ShardFacts {
  readonly id: string;
  readonly name: string;
  readonly kind: ShardKindName;
  readonly status: ShardStatusName;
  readonly statusChangedAt: Date;
  /** Institutions on it, not purged. */
  readonly held: number;
  readonly capacity: number;
  /** Its last migration run's error code, when that run failed. */
  readonly runErrorCode: string | null;
  /** The worker's last check, or null if it has never checked this shard. */
  readonly health: { readonly ok: boolean; readonly checkedAt: Date; readonly errorCode: string | null; readonly lastSuccessAt: Date | null } | null;
}

export type ShardWarning =
  | { readonly type: 'pool_nearly_full'; readonly shard: string; readonly held: number; readonly capacity: number }
  | { readonly type: 'ready_low'; readonly ready: number; readonly minimum: number }
  | { readonly type: 'maintenance'; readonly shard: string; readonly errorCode: string | null; readonly since: Date }
  | { readonly type: 'unreachable'; readonly shard: string; readonly errorCode: string | null; readonly lastSuccessAt: Date | null }
  | { readonly type: 'unchecked'; readonly shard: string; readonly checkedAt: Date | null };

/** Every warning, in the order the page shows them: what stops institutions first, then what will. */
export function shardWarnings(shards: readonly ShardFacts[], minimumReady: number, now: Date): ShardWarning[] {
  const live = shards.filter((s) => s.status !== 'RETIRED');
  const out: ShardWarning[] = [];
  for (const s of live) if (s.status === 'MAINTENANCE') out.push({ type: 'maintenance', shard: s.name, errorCode: s.runErrorCode, since: s.statusChangedAt });
  for (const s of live) {
    if (!s.health || now.getTime() - s.health.checkedAt.getTime() > HEALTH_STALE_MS) out.push({ type: 'unchecked', shard: s.name, checkedAt: s.health?.checkedAt ?? null });
    else if (!s.health.ok) out.push({ type: 'unreachable', shard: s.name, errorCode: s.health.errorCode, lastSuccessAt: s.health.lastSuccessAt });
  }
  const ready = live.filter((s) => s.kind === 'DEDICATED' && s.status === 'READY').length;
  if (ready < minimumReady) out.push({ type: 'ready_low', ready, minimum: minimumReady });
  for (const s of live) if (s.kind === 'POOL' && s.held >= s.capacity * POOL_NEARLY_FULL) out.push({ type: 'pool_nearly_full', shard: s.name, held: s.held, capacity: s.capacity });
  return out;
}
