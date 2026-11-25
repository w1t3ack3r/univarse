// Spec 0039 Q5, Q6 (Q-B3): a database server's connection budget, counted one way for `pnpm stack:shards` (which
// refuses past it) and for the console's Shards page (which shows it). PgBouncer pools per database and role, so the
// platform database's three roles count 10 each.

/** PgBouncer's pools on the platform database (the API's, the console's and the relay's roles, 10 each). */
export const PLATFORM_POOLS = 30;
/** Q3: a dedicated database's PgBouncer pool (its fallback entry's pool_size). */
export const DEDICATED_POOL_SIZE = 3;
/** Q5: below this many READY dedicated databases, the deploy, `stack:shards list` and the console warn. */
export const MINIMUM_READY = 2;

/** Q6: the connections a server has left for new shards: `max_connections` − reserved − the platform's − its shards'. */
export function budgetLeft(s: { maxConnections: number; reservedConnections: number; shardPoolSizes: readonly number[] }): number {
  return s.maxConnections - s.reservedConnections - PLATFORM_POOLS - s.shardPoolSizes.reduce((a, b) => a + b, 0);
}

/** Q6: how many more dedicated databases a budget holds. */
export const dedicatedRoom = (left: number): number => Math.max(0, Math.floor(left / DEDICATED_POOL_SIZE));
