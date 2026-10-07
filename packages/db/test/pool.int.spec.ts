/**
 * Idle connections are kept (packages/db/src/pool.ts). With pg's default 10 s idle timeout, the first
 * query after a lull had to open a connection inside Prisma's 2 s transaction `maxWait`, and failed
 * with P2028 on a loaded machine (E2E sign-in, 2026-10-05).
 *
 * ADR-026: the pool holds 10 connections and a transaction waits 2 s for one. When none frees up, the
 * failure is recognised as "no connection available" (the API answers 503 server.busy), and other P2028s
 * are not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformClient } from '../src/platform.js';
import { isConnectionUnavailable, POOL_OPTIONS, TRANSACTION_OPTIONS } from '../src/pool.js';
import { createTenantShardClient, forTenant, withTenantTx, type TenantShardClient } from '../src/tenant.js';
import { loadRootEnv, requireEnv } from '../scripts/env.js';

let shard: TenantShardClient;
let tenantId: string;

beforeAll(async () => {
  loadRootEnv();
  shard = createTenantShardClient(requireEnv('TENANT_POOL_01_DATABASE_URL'));
  const platform = createPlatformClient(requireEnv('PLATFORM_DATABASE_URL'));
  tenantId = (await platform.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' } })).id;
  await platform.$disconnect();
});
afterAll(async () => {
  await shard.$disconnect();
});

const backendPid = async () =>
  (await withTenantTx(shard, tenantId, (tx) => tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`))[0]!.pid;

describe('connection pool', () => {
  it('reuses the same connection after an idle gap longer than pg’s 10 s default', async () => {
    const before = await backendPid();
    await new Promise((r) => setTimeout(r, 11_000));
    expect(await backendPid()).toBe(before);
  });
});

/**
 * Opens `n` transactions that stay open until `gate` resolves: one at a time, retrying a start that found no
 * connection in time (on a loaded machine, opening a connection can take longer than the 2 s wait).
 */
async function holdConnections(n: number, run: (body: () => Promise<void>) => Promise<unknown>, gate: Promise<void>): Promise<Promise<unknown>[]> {
  const holders: Promise<unknown>[] = [];
  for (let attempts = 0; holders.length < n; attempts++) {
    if (attempts > 5 * n) throw new Error(`Could only open ${String(holders.length)} of ${String(n)} connections`);
    let open!: () => void;
    const isOpen = new Promise<'open'>((r) => (open = () => r('open')));
    const holder = run(async () => {
      open();
      await gate;
    });
    const outcome = await Promise.race([isOpen, holder.then(() => new Error('holder ended early'), (e: unknown) => e)]);
    if (outcome === 'open') holders.push(holder);
    else if (!isConnectionUnavailable(outcome)) throw outcome;
  }
  return holders;
}

describe('[ADR-026] pool exhaustion', () => {
  it('pins the pool size and transaction wait', () => {
    expect([POOL_OPTIONS.max, TRANSACTION_OPTIONS.maxWait]).toEqual([10, 2_000]);
  });

  it('a transaction that gets no connection within 2 s fails as "connection unavailable"; the pool recovers', { timeout: 120_000 }, async () => {
    const client = createTenantShardClient(requireEnv('TENANT_POOL_01_DATABASE_URL'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    try {
      // Hold every connection in an open transaction.
      const holders = await holdConnections(
        POOL_OPTIONS.max,
        (body) =>
          withTenantTx(client, tenantId, async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            await body();
          }),
        gate,
      );

      const started = performance.now();
      const interactive = await withTenantTx(client, tenantId, (tx) => tx.$queryRaw`SELECT 1`).then(() => null, (e: unknown) => e);
      const waited = performance.now() - started;
      const single = await forTenant(client, tenantId).role.count().then(() => null, (e: unknown) => e);

      expect(isConnectionUnavailable(interactive), String(interactive)).toBe(true); // ShardRegistry.tx
      expect(isConnectionUnavailable(single), String(single)).toBe(true); // ShardRegistry.forTenant
      expect(waited).toBeGreaterThanOrEqual(1_900);
      expect(waited).toBeLessThan(5_000);

      release();
      await Promise.all(holders);
      expect(await forTenant(client, tenantId).role.count()).toBeGreaterThan(0);
    } finally {
      release();
      await client.$disconnect();
    }
  });

  it('a transaction that outlives its timeout is a different P2028, and is not matched', async () => {
    const err = await withTenantTx(
      shard,
      tenantId,
      async (tx) => {
        await new Promise((r) => setTimeout(r, 300));
        return tx.$queryRaw`SELECT 1`;
      },
      { timeoutMs: 100 },
    ).then(() => null, (e: unknown) => e);
    expect((err as { code?: string } | null)?.code).toBe('P2028');
    expect(isConnectionUnavailable(err)).toBe(false);
  });

  it('matches pg failing to open a connection in time, and nothing else', () => {
    expect(isConnectionUnavailable(new Error('Connection terminated due to connection timeout'))).toBe(true);
    expect(isConnectionUnavailable(new Error('connection refused'))).toBe(false);
    expect(isConnectionUnavailable({ code: 'P2028', message: 'Unable to start a transaction in the given time' })).toBe(false); // not an Error
    expect(isConnectionUnavailable(undefined)).toBe(false);
  });
});
