// Spec 0017 PB7: saturation is shed as 503 server.busy when PgBouncer's query_wait_timeout ends the wait, through the
// API, with PgBouncer in the PROBE profile (2 server connections per pool, query_wait_timeout 2 s). Runs with
// `pnpm --filter @univarse/api test:pgbouncer:probe` (or the pgbouncer-isolation job): it needs PgBouncer up in the
// probe profile, PLATFORM_DATABASE_URL and TENANT_POOL_01_DATABASE_URL pointed at it, and the superuser
// (PGHOST, PGPORT, PGSUPERPASSWORD) for the unrelated-error control.
import { existsSync } from 'node:fs';
import type { ArgumentsHost } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, createTenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { ProblemFilter, UNAVAILABLE_RETRY_AFTER_SEC } from './problem.filter.js';

// The repository's .env (as the integration suites' global setup loads it); variables already set win, so CI's
// PgBouncer URLs in PLATFORM_DATABASE_URL / TENANT_POOL_01_DATABASE_URL are kept.
const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const env = process.env as Record<string, string | undefined>;
const PLATFORM = env.PLATFORM_DATABASE_URL ?? '';
const TENANT = env.TENANT_POOL_01_DATABASE_URL ?? '';
const HOST = 'demo-uni.univarse.localhost';
const QUERY_WAIT_TIMEOUT_MS = 2_000;

/**
 * Holds both of the pool's server connections (the probe profile's pool is 2) in open interactive transactions, each
 * on its own client, until released. Opened one at a time, each confirmed open before the next.
 */
async function holdPool(url: string): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const clients = [createTenantShardClient(url), createTenantShardClient(url)];
  const holders: Promise<unknown>[] = [];
  for (const c of clients) {
    let open!: () => void;
    const isOpen = new Promise<void>((r) => (open = r));
    holders.push(
      c.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          open();
          await gate;
        },
        { maxWait: 10_000, timeout: 60_000 },
      ),
    );
    await isOpen;
  }
  return async () => {
    release();
    await Promise.allSettled(holders);
    await Promise.all(clients.map((c) => c.$disconnect()));
  };
}
/** The superuser, directly on the platform database (for the injected-error control only). */
const superuser = () => {
  if (!env.PGSUPERPASSWORD)
    throw new Error('PB7 needs PGSUPERPASSWORD for the unrelated-error control (CI provides it)');
  return createPlatformClient(
    `postgresql://${env.PGSUPERUSER ?? 'postgres'}:${encodeURIComponent(env.PGSUPERPASSWORD)}@${env.PGHOST ?? '127.0.0.1'}:${env.PGPORT ?? '5432'}/univarse_platform`,
  );
};

let app: NestFastifyApplication | undefined;
const started = () => {
  if (!app) throw new Error('the app did not start (see beforeAll)');
  return app;
};
const profile = () =>
  started()
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: '/api/v1/tenant/public-profile', headers: { host: HOST } });

beforeAll(async () => {
  // Both URLs must go through PgBouncer, or nothing here tests it.
  // Host and port only: a failed expect on the URL itself would print its password.
  for (const url of [PLATFORM, TENANT])
    expect(url ? new URL(url).host : 'unset').toBe('127.0.0.1:6432');
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
}, 60_000);
afterAll(async () => {
  await app?.close(); // undefined when the app never started: the cause is reported by beforeAll
});

describe('[PB7] saturation outside a transaction is shed as 503 server.busy (ADR-026, probe profile)', () => {
  it('[PB7] an uncached platform lookup through a saturated PgBouncer answers 503 server.busy with Retry-After, within query_wait_timeout + 1 s; then recovers', async () => {
    // This app has looked up no host yet: the tenant resolver's lookup is uncached, outside any transaction.
    const release = await holdPool(PLATFORM);
    let res;
    const t0 = Date.now();
    try {
      res = await profile();
    } finally {
      await release();
    }
    const elapsed = Date.now() - t0;
    expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([503, 'server.busy']);
    expect(res.headers['retry-after']).toBe(String(UNAVAILABLE_RETRY_AFTER_SEC));
    expect(res.body).not.toMatch(/prisma|query_wait_timeout|08P01|P2039/i); // no internals leak
    expect(elapsed).toBeLessThanOrEqual(QUERY_WAIT_TIMEOUT_MS + 1_000);
    // Recovery: with the holders gone, the same lookup answers.
    const after = await profile();
    expect(after.statusCode).toBe(200);
    expect(after.json<{ slug: string }>().slug).toBe('demo-uni');
  }, 60_000);

  it('[PB7] an unrelated error in the same path still answers 500 (the mapping is narrow)', async () => {
    const su = superuser();
    const fresh = await createApp(
      loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    );
    try {
      await su.$executeRawUnsafe('REVOKE SELECT ON tenant_domain FROM univarse_app_platform'); // a server error, injected
      const res = await fresh
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'GET',
          url: '/api/v1/tenant/public-profile',
          headers: { host: HOST },
        });
      expect([res.statusCode, res.json<{ code: string }>().code]).toEqual([500, 'server.internal']);
    } finally {
      await su.$executeRawUnsafe('GRANT SELECT ON tenant_domain TO univarse_app_platform');
      await su.$disconnect();
      await fresh.close();
    }
  }, 60_000);
});

describe('[PB7] a queued transaction start, where PgBouncer’s deadline wins', () => {
  it('[PB7] a transaction start queued past query_wait_timeout (maxWait 5 s) is shed by the problem filter as 503 server.busy with Retry-After', async () => {
    // A test-only client whose own deadline (5 s) can't fire before PgBouncer's (2 s).
    const longWait = createTenantShardClient(TENANT);
    const release = await holdPool(TENANT);
    let error: unknown;
    try {
      await longWait.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 5_000 });
    } catch (e) {
      error = e;
    } finally {
      await release();
      await longWait.$disconnect();
    }
    expect(error, 'the transaction start should have been ended by PgBouncer').toBeInstanceOf(
      Error,
    );
    expect((error as { code?: string }).code).toBe('P2039'); // PgBouncer's deadline, not Prisma's P2028

    // Through the API's real problem filter.
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = {
      headers: {},
    };
    const reply = {
      status: (s: number) => ((sent.status = s), reply),
      header: (k: string, v: string) => ((sent.headers[k.toLowerCase()] = v), reply),
      send: (b: unknown) => ((sent.body = b), reply),
    };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ id: 'pb7-probe' }), getResponse: () => reply }),
    } as unknown as ArgumentsHost;
    new ProblemFilter().catch(error, host);
    expect(sent.status).toBe(503);
    expect((sent.body as { code: string }).code).toBe('server.busy');
    expect(sent.headers['retry-after']).toBe(String(UNAVAILABLE_RETRY_AFTER_SEC));
  }, 60_000);
});
