// Vitest globalSetup for API integration tests: fail fast, with a clear message, when a dependency
// is down. The rate limiter deliberately FAILS OPEN without Valkey (docs/06 §7), so a missing Valkey
// otherwise shows up as misleading "rate limiting is broken" test failures (seen 2026-10-04).
import { existsSync } from 'node:fs';
import { createTenantShardClient } from '@univarse/db';
import { Redis } from 'ioredis';

export default async function setup(): Promise<void> {
  const rootEnv = new URL('../../../../.env', import.meta.url);
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

  const problems: string[] = [];

  const valkey = new Redis(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  valkey.on('error', () => undefined); // reported once below, not as an unhandled event
  try {
    await valkey.connect();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- typed as 'PONG'; this checks what the server actually sent
    if ((await valkey.ping()) !== 'PONG') problems.push('Valkey did not answer PING');
  } catch (err) {
    problems.push(`Valkey unreachable at VALKEY_URL (${err instanceof Error ? err.message : String(err)}). Start it: pnpm dev:infra`);
  } finally {
    valkey.disconnect();
  }

  const db = createTenantShardClient(process.env.TENANT_POOL_01_DATABASE_URL ?? 'postgresql://unset');
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    problems.push(`PostgreSQL unreachable (${err instanceof Error ? err.message : String(err)}). Run: pnpm db:setup && pnpm db:migrate`);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }

  if (problems.length > 0) {
    throw new Error(`Integration test prerequisites missing:\n  - ${problems.join('\n  - ')}`);
  }
}
