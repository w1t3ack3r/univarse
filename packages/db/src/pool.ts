import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';

/**
 * Pool settings for every Prisma client (platform and tenant shards).
 *
 * - Every connection runs in UTC. The pg adapter exchanges `timestamptz` values as zone-less UTC
 *   strings, so a server or role whose TimeZone isn't UTC (e.g. a local install in Africa/Lagos)
 *   would store every timestamp shifted by its offset and break comparisons with SQL `now()`.
 *   Found by the outbox retry test (spec 0002 B4), 2026-10-05.
 * - Idle connections are kept for 5 minutes, not pg's default 10 s. `forTenant` runs every operation
 *   in a transaction, and Prisma gives a transaction 2 s (`maxWait`) to get a connection. With a
 *   10 s idle timeout, any request after a short lull had to open a new connection inside those
 *   2 s; on a loaded machine that took 1–13 s and the request failed with P2028 ("Unable to start
 *   a transaction in the given time"), a 500 on sign-in. Found by the E2E suite, 2026-10-05.
 *   These are Prisma 6's own defaults, which the move to driver adapters (Prisma 7) dropped.
 * - Opening a connection gives up after 5 s instead of waiting forever. Inside a transaction (every tenant
 *   operation) the 2 s wait below ends a slow open first, as P2028; the 5 s bound applies to opens outside
 *   one (platform reads). Both become 503 `server.busy` (ADR-026).
 * - At most 10 connections per client (pg's default, now explicit; ADR-026). The load test of
 *   2026-10-07 found a larger pool adds no throughput and fails sooner: the extra connections are
 *   opened under load, inside the 2 s wait. Capacity comes from more replicas, not bigger pools.
 */
export const POOL_OPTIONS = { max: 10, idleTimeoutMillis: 300_000, connectionTimeoutMillis: 5_000 } as const;

/**
 * Prisma's default transaction wait, made explicit (ADR-026): a transaction that can't get a pooled
 * connection within 2 s fails, and the API answers 503 `server.busy` with `Retry-After`. This is the
 * queue deadline; a longer wait only turns refusals into multi-second latency (measured 2026-10-07).
 */
export const TRANSACTION_OPTIONS = { maxWait: 2_000 } as const;

export const utcAdapter = (connectionString: string) =>
  new PrismaPg({ connectionString, options: '-c TimeZone=UTC', ...POOL_OPTIONS });

/**
 * True when an operation failed because no database connection became available in time:
 * Prisma's transaction wait expired (P2028 "Unable to start a transaction in the given time"), pg
 * could not open a new connection within `connectionTimeoutMillis`, or PgBouncer's `query_wait_timeout`
 * ended the wait in its queue (spec 0017 PB7). Other P2028s (e.g. a transaction that expired mid-way)
 * are bugs, not saturation, and are not matched.
 */
export function isConnectionUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'P2028') return err.message.includes('Unable to start a transaction in the given time');
  if (isPgBouncerQueueTimeout(err)) return true;
  return err.message === 'Connection terminated due to connection timeout';
}

/**
 * PgBouncer ended a query or a transaction start waiting in its queue (`query_wait_timeout`), exactly as
 * captured on 2026-10-14 (Prisma 7.10, PgBouncer 1.26.1, outside a transaction and at a transaction's
 * start alike): a PrismaClientKnownRequestError P2039 whose driver adapter error is PgBouncer's FATAL
 * 08P01 "query_wait_timeout". Matched narrowly, field by field: PgBouncer reports many of its own errors as
 * 08P01, and a message substring could match anything.
 */
function isPgBouncerQueueTimeout(err: Error): boolean {
  if (!(err instanceof PrismaClientKnownRequestError) || err.code !== 'P2039') return false;
  const adapterError = err.meta?.driverAdapterError;
  if (!(adapterError instanceof Error) || adapterError.name !== 'DriverAdapterError') return false;
  if (adapterError.message !== 'query_wait_timeout') return false;
  const cause = adapterError.cause as Record<string, unknown> | undefined;
  return (
    cause?.kind === 'postgres' &&
    cause.code === '08P01' &&
    cause.originalCode === '08P01' &&
    cause.originalMessage === 'query_wait_timeout' &&
    cause.severity === 'FATAL'
  );
}
