/**
 * Timestamps are stored as the true instant whatever the server's TimeZone (packages/db/src/pool.ts).
 * Meaningful only on a non-UTC server: CI's Postgres runs in Africa/Lagos for this reason.
 * Since spec 0017 D6 the app roles also have a UTC `timezone` default, so "the session is UTC" alone can no longer
 * show that the client sent `-c TimeZone=UTC`: the setting's source must be the client (or, through PgBouncer, the
 * session it re-applies the client's value in), never the role default.
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
const TZ_SOURCE = "SELECT current_setting('TimeZone') AS tz, source FROM pg_settings WHERE name = 'TimeZone'";
/** Where a session's TimeZone came from: the client's startup option, never a role or server default. */
const FROM_THE_CLIENT = ['client', 'session'];

beforeAll(async () => {
  loadRootEnv();
  shard = createTenantShardClient(requireEnv('TENANT_POOL_01_DATABASE_URL'));
  platform = createPlatformClient(requireEnv('PLATFORM_DATABASE_URL'));
  tenantId = (await platform.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' } })).id;
  const raw = new pg.Client({ connectionString: requireEnv('TENANT_POOL_01_DATABASE_URL') });
  await raw.connect();
  const row = (await raw.query<{ tz: string; source: string }>(TZ_SOURCE)).rows[0]!;
  serverDefault = `${row.tz} (from ${row.source})`;
  await raw.end();
  console.log(`TimeZone without the client option: ${serverDefault}`);
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

  it("the UTC comes from the client's option, not the role default (spec 0017 D6)", async () => {
    const [tenant] = await withTenantTx(shard, tenantId, (tx) =>
      tx.$queryRaw<{ tz: string; source: string }[]>`SELECT current_setting('TimeZone') AS tz, source FROM pg_settings WHERE name = 'TimeZone'`,
    );
    const [plat] = await platform.$queryRaw<{ tz: string; source: string }[]>`SELECT current_setting('TimeZone') AS tz, source FROM pg_settings WHERE name = 'TimeZone'`;
    for (const s of [tenant!, plat!]) {
      expect(s.tz).toBe('UTC');
      expect(FROM_THE_CLIENT).toContain(s.source);
    }
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
