/**
 * Idle connections are kept (packages/db/src/pool.ts). With pg's default 10 s idle timeout, the first
 * query after a lull had to open a connection inside Prisma's 2 s transaction `maxWait`, and failed
 * with P2028 on a loaded machine (E2E sign-in, 2026-10-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformClient } from '../src/platform.js';
import { createTenantShardClient, withTenantTx, type TenantShardClient } from '../src/tenant.js';
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
