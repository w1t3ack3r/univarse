/**
 * Timestamps are stored as the true instant whatever the server's TimeZone (packages/db/src/pool.ts).
 * Meaningful only on a non-UTC server: CI's Postgres runs in Africa/Lagos for this reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPlatformClient, type PlatformClient } from '../src/platform.js';
import { createTenantShardClient, withTenantTx, type TenantShardClient } from '../src/tenant.js';
import { loadRootEnv, requireEnv } from '../scripts/env.js';

let shard: TenantShardClient;
let platform: PlatformClient;
let tenantId: string;
let serverDefault = '';

beforeAll(async () => {
  loadRootEnv();
  shard = createTenantShardClient(requireEnv('TENANT_POOL_01_DATABASE_URL'));
  platform = createPlatformClient(requireEnv('PLATFORM_DATABASE_URL'));
  tenantId = (await platform.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' } })).id;
  const raw = new pg.Client({ connectionString: requireEnv('TENANT_POOL_01_DATABASE_URL') });
  await raw.connect();
  serverDefault = (await raw.query<{ TimeZone: string }>('SHOW TimeZone')).rows[0]!.TimeZone;
  await raw.end();
  console.log(`server default TimeZone: ${serverDefault}`);
});
afterAll(async () => {
  await shard.$disconnect();
  await platform.$disconnect();
});

describe('timestamps are true instants (UTC sessions)', () => {
  it('every Prisma connection runs in UTC, whatever the server default', async () => {
    const [tenantTz] = await withTenantTx(shard, tenantId, (tx) => tx.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`);
    const [platformTz] = await platform.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(tenantTz!.tz).toBe('UTC');
    expect(platformTz!.tz).toBe('UTC');
  });

  it('a JS Date written through Prisma is stored as the same instant, and lines up with SQL now()', async () => {
    const written = new Date();
    const [row] = await withTenantTx(shard, tenantId, async (tx) => {
      const ev = await tx.outboxEvent.create({ data: { tenantId, type: 'test.timezone', status: 'DEAD', nextAttemptAt: written } });
      return tx.$queryRaw<{ stored: number; db_now: number }[]>`
        SELECT extract(epoch FROM next_attempt_at)::float8 AS stored, extract(epoch FROM now())::float8 AS db_now
        FROM outbox_event WHERE id = ${ev.id}::uuid`;
    });
    expect(row!.stored * 1000).toBeCloseTo(written.getTime(), -1); // same instant (ms precision)
    expect(Math.abs(row!.db_now * 1000 - written.getTime())).toBeLessThan(5_000);
  });
});
