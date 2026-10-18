/**
 * Spec 0016 end to end: the database's capture, the worker's relay (on its own role) and the API instances'
 * caches, against real Postgres and Valkey. IO3 (any writer reaches both instances), IO12 (a long transaction;
 * differing instance TTLs, against the database's shared maximum) and IO13 (the resolver's subscriber, negative
 * entries and global generation). Prereqs as the relay's suite: `pnpm dev:infra`, `pnpm db:setup`,
 * `pnpm db:migrate && pnpm db:seed`; no worker running.
 *
 * Two tests shorten the database's maximum TTL and restore it in `finally` (the IO15 gate checks the value).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { createPlatformClient, PlatformModels, type PlatformClient } from '@univarse/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { APP_CONFIG, loadConfig, type AppConfig } from '../../config/config.js';
import { relayUrl } from '../../testing/relay-env.js';
import { PLATFORM_DB } from '../db/db.module.js';
import { CHANNELS, InvalidationBus, type PublishResult } from '../infra/invalidation-bus.js';
import { PlatformInvalidationRelay, type PublishFn } from '../infra/platform-invalidation-relay.js';
import { TenantResolver } from './tenant-resolver.service.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379';
const MAX_MS = 60_000;

let mig: PlatformClient; // univarse_migrator
let shardId: string;
const tenants = new Set<string>();
const relays: PlatformInvalidationRelay[] = [];
const redises: Redis[] = [];
const apps: INestApplication[] = [];
const clients: PlatformClient[] = [];

const q = <T = unknown>(sql: string, ...params: unknown[]) =>
  mig.$queryRawUnsafe<T[]>(sql, ...params);
const x = (sql: string, ...params: unknown[]) => mig.$executeRawUnsafe(sql, ...params);
const DELIVERED: PublishResult = { delivered: true, receivers: 0 };

const redis = (url = VALKEY_URL) => {
  const r = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 1_000,
  });
  r.on('error', () => undefined);
  redises.push(r);
  return r;
};
const ready = async (r: Redis) => {
  await new Promise<void>((resolve) =>
    r.status === 'ready' ? resolve() : r.once('ready', () => resolve()),
  );
  return r;
};
const client = (url: string) => {
  const c = createPlatformClient(url);
  clients.push(c);
  return c;
};
const relay = (publish: PublishFn) => {
  const r = new PlatformInvalidationRelay(client(relayUrl()), publish);
  relays.push(r);
  return r;
};
/** A relay publishing on real Valkey. */
const liveRelay = async () => {
  const bus = new InvalidationBus(await ready(redis()), false);
  return relay((c, t, ms) => bus.publish(c, t, ms));
};
/** A relay whose Valkey is unreachable: every publish fails, so events wait and eventually expire. */
const downRelay = () => {
  const bus = new InvalidationBus(redis('redis://127.0.0.1:1'), false);
  return relay((c, t, ms) => bus.publish(c, t, ms));
};
async function drain(): Promise<void> {
  const r = relay(() => Promise.resolve(DELIVERED));
  for (let i = 0; i < 100; i++) if ((await r.runOnce()).claimed === 0) return;
  throw new Error('backlog did not drain');
}

const instance = async (env: Record<string, string> = {}) => {
  const app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', ...env }));
  apps.push(app);
  await app.get(InvalidationBus).ready();
  return app;
};
const statusOn = async (app: INestApplication, host: string) =>
  (await app.get(TenantResolver).resolveHost(host))?.status ?? null;

/** An ACTIVE tenant with a verified subdomain. */
async function newTenant(): Promise<{ id: string; host: string }> {
  const slug = `ti-${randomBytes(6).toString('hex')}`;
  const [row] = await q<{ id: string }>(
    `INSERT INTO public.tenant (slug, legal_name, short_name, type, ownership, status, shard_id, updated_at)
     VALUES ($1, 'Invalidation College', 'IC', 'COLLEGE_OF_EDUCATION', 'STATE', 'ACTIVE', $2::uuid, now()) RETURNING id::text`,
    slug,
    shardId,
  );
  const id = row!.id;
  const host = `${slug}.invalidation.test`;
  await x(
    `INSERT INTO public.tenant_domain (tenant_id, hostname, kind, verified_at) VALUES ($1::uuid, $2, 'SUBDOMAIN', now())`,
    id,
    host,
  );
  tenants.add(id);
  return { id, host };
}

/** Polls until `check` holds; returns the milliseconds it took, or Infinity after `ms`. */
async function within(ms: number, check: () => Promise<boolean>): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < ms) {
    if (await check()) return performance.now() - start;
    await sleep(20);
  }
  return Number.POSITIVE_INFINITY;
}

async function setMaxTtl(ms: number): Promise<void> {
  await x(`CREATE OR REPLACE FUNCTION public.cache_invalidation_max_ttl() RETURNS interval
    LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
    AS $$ SELECT interval '${String(ms)} milliseconds' $$`);
}

beforeAll(async () => {
  mig = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  const [shard] = await q<{ id: string }>(
    `INSERT INTO public.shard (name, kind, secret_ref, region) VALUES ($1, 'POOL', 'INVALIDATION_TEST_DATABASE_URL', 'local') RETURNING id::text`,
    `invalidation-test-${randomBytes(4).toString('hex')}`,
  );
  shardId = shard!.id;
});

afterAll(async () => {
  await Promise.all(relays.map((r) => r.stop()));
  await Promise.all(apps.map((a) => a.close()));
  for (const r of redises) r.disconnect();
  await Promise.all(clients.map((c) => c.$disconnect()));
  await x(`DELETE FROM public.tenant WHERE id = ANY($1::uuid[])`, [...tenants]);
  await x(`DELETE FROM public.shard WHERE id = $1::uuid`, shardId);
  await x(
    `UPDATE public.cache_invalidation_event SET status = 'PUBLISHED' WHERE status = 'PENDING' AND tenant_id = ANY($1::uuid[])`,
    [...tenants],
  );
  await mig.$disconnect();
});

describe('[IO3][IO13] every writer reaches both API instances', () => {
  let one: INestApplication;
  let two: INestApplication;
  let live: PlatformInvalidationRelay;

  beforeAll(async () => {
    await drain();
    one = await instance();
    two = await instance();
    live = await liveRelay();
    live.start();
  });
  afterAll(async () => {
    await live.stop();
  });

  it('[IO3] changes made without the API code reach both instances within 2 s: app role, migrator, stored function, dynamic SQL, a type that lies', async () => {
    const { id, host } = await newTenant();
    const app = client(process.env.PLATFORM_DATABASE_URL!);
    const fn = `io3_${randomBytes(4).toString('hex')}`;
    await x(`CREATE SCHEMA ${fn}`);
    await x(
      `CREATE FUNCTION ${fn}.set_status(t uuid, s text) RETURNS void LANGUAGE plpgsql AS $$
         BEGIN UPDATE public.tenant SET status = s::"TenantStatus" WHERE id = t; END $$`,
    );
    // The API's own client, with the statement typed as a string on its way to the template (spec 0015's record).
    const theLie = (s: string) => {
      const sql = PlatformModels.Prisma
        .sql`UPDATE public.tenant SET status = ${s}::"TenantStatus" WHERE id = ${id}::uuid` as unknown as string;
      // Typed as a string (a bound parameter); at run time it's a SQL fragment, spliced in.
      return one.get<PlatformClient>(PLATFORM_DB).$executeRaw`${sql}`;
    };
    const writers: [string, (s: string) => Promise<unknown>][] = [
      [
        'a plain connection as the app role',
        (s) =>
          app.$executeRawUnsafe(
            `UPDATE public.tenant SET status = $1::"TenantStatus" WHERE id = $2::uuid`,
            s,
            id,
          ),
      ],
      [
        'the migrator role',
        (s) => x(`UPDATE public.tenant SET status = $1::"TenantStatus" WHERE id = $2::uuid`, s, id),
      ],
      ['a stored function', (s) => x(`SELECT ${fn}.set_status($1::uuid, $2)`, id, s)],
      [
        'EXECUTE of SQL built at run time',
        (s) =>
          app.$executeRawUnsafe(
            `DO $$ BEGIN EXECUTE 'UPDATE public.' || 'tenant SET status = ' || quote_literal('${s}') || '::"TenantStatus" WHERE id = ' || quote_literal('${id}') || '::uuid'; END $$`,
          ),
      ],
      ['a type that lies', theLie],
    ];
    try {
      let current = 'ACTIVE';
      for (const [name, write] of writers) {
        expect([name, await statusOn(one, host), await statusOn(two, host)]).toEqual([
          name,
          current,
          current,
        ]); // both cached
        const next = current === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
        await write(next);
        const ms = await within(
          2_000,
          async () => (await statusOn(one, host)) === next && (await statusOn(two, host)) === next,
        );
        expect([name, ms]).toEqual([name, expect.any(Number)]);
        expect(ms).toBeLessThan(2_000);
        current = next;
      }
    } finally {
      await x(`DROP SCHEMA ${fn} CASCADE`);
    }
  }, 60_000);

  it('[IO13] a newly added or verified hostname resolves on both instances within 2 s (their negative entries are evicted)', async () => {
    const { id } = await newTenant();
    const added = `ti-new-${randomBytes(4).toString('hex')}.invalidation.test`;
    const verified = `ti-ver-${randomBytes(4).toString('hex')}.invalidation.test`;
    await x(
      `INSERT INTO public.tenant_domain (tenant_id, hostname, kind) VALUES ($1::uuid, $2, 'CUSTOM')`,
      id,
      verified,
    );
    for (const h of [added, verified])
      for (const a of [one, two]) expect(await a.get(TenantResolver).resolveHost(h)).toBeNull(); // cached negative
    await x(
      `INSERT INTO public.tenant_domain (tenant_id, hostname, kind, verified_at) VALUES ($1::uuid, $2, 'SUBDOMAIN', now())`,
      id,
      added,
    );
    await x(`UPDATE public.tenant_domain SET verified_at = now() WHERE hostname = $1`, verified);
    for (const h of [added, verified]) {
      const ms = await within(
        2_000,
        async () => (await statusOn(one, h)) === 'ACTIVE' && (await statusOn(two, h)) === 'ACTIVE',
      );
      expect([h, ms < 2_000]).toEqual([h, true]);
    }
  });

  it('[IO13] an in-flight negative lookup that a tenants message overtakes does not cache null', async () => {
    const { id } = await newTenant();
    const host = `ti-held-${randomBytes(4).toString('hex')}.invalidation.test`;
    // "Instance 2": a resolver with its own subscribed bus, whose database read is held open after it returns.
    const real = client(process.env.PLATFORM_DATABASE_URL!);
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let readDone!: () => void;
    const didRead = new Promise<void>((r) => (readDone = r));
    const platform = {
      tenantDomain: {
        findUnique: async (args: Parameters<PlatformClient['tenantDomain']['findUnique']>[0]) => {
          const result = await real.tenantDomain.findUnique(args);
          if (!held) {
            held = true;
            readDone();
            await gate;
          }
          return result;
        },
      },
    } as unknown as PlatformClient;
    const bus = new InvalidationBus(await ready(redis()), true);
    const resolver = new TenantResolver(platform, one.get<AppConfig>(APP_CONFIG), bus);
    resolver.onModuleInit();
    await bus.ready();

    const lookup = resolver.resolveHost(host);
    await didRead; // it read "no such host" and is held
    const before = bus.received.get(CHANNELS.tenants) ?? 0;
    await x(
      `INSERT INTO public.tenant_domain (tenant_id, hostname, kind, verified_at) VALUES ($1::uuid, $2, 'SUBDOMAIN', now())`,
      id,
      host,
    );
    expect(
      await within(2_000, () =>
        Promise.resolve((bus.received.get(CHANNELS.tenants) ?? 0) > before),
      ),
    ).toBeLessThan(2_000);
    release();
    expect(await lookup).toBeNull(); // served, stale, but never cached
    expect((await resolver.resolveHost(host))?.tenantId).toBe(id);
    bus.stopListening();
  });
});

describe('[IO12] expiry waits for the shared maximum; caches converge on their own TTL', () => {
  it('[IO12] a transaction held past the maximum, committed with Valkey down: not expired before first observation + max + 5 s; B serves the new value within its TTL of a fresh load', async () => {
    const max = 4_000;
    await drain();
    const { id, host } = await newTenant();
    await drain();
    const b = await instance({ TENANT_CACHE_TTL_MS: String(max) });
    const down = downRelay();
    await setMaxTtl(max);
    try {
      down.start();
      let commit!: () => void;
      const commitGate = new Promise<void>((r) => (commit = r));
      let changed!: () => void;
      const didChange = new Promise<void>((r) => (changed = r));
      const writing = mig.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE public.tenant SET status = 'SUSPENDED' WHERE id = $1::uuid`,
            id,
          );
          changed();
          await commitGate;
        },
        { timeout: 30_000 },
      );
      await didChange;
      await sleep(max + 500); // held longer than the maximum TTL
      b.get(TenantResolver).invalidate();
      const freshLoad = performance.now();
      expect(await statusOn(b, host)).toBe('ACTIVE'); // B freshly caches the old value
      commit();
      await writing;
      const [atCommit] = await q<{ status: string }>(
        `SELECT status FROM public.cache_invalidation_event WHERE tenant_id = $1::uuid AND source = 'tenant:UPDATE'`,
        id,
      );
      expect(atCommit?.status).toBe('PENDING');
      // B converges on its own TTL, counted from that fresh load.
      expect(
        await within(max + 1_000, async () => (await statusOn(b, host)) === 'SUSPENDED'),
      ).toBeLessThan(Number.POSITIVE_INFINITY);
      expect(performance.now() - freshLoad).toBeLessThanOrEqual(max + 300);
      // The event expires, but never before first observation + max + 5 s, by the database's clock.
      expect(
        await within(max + 10_000, async () => {
          const [e] = await q<{ status: string }>(
            `SELECT status FROM public.cache_invalidation_event WHERE tenant_id = $1::uuid AND source = 'tenant:UPDATE'`,
            id,
          );
          return e?.status === 'EXPIRED';
        }),
      ).toBeLessThan(Number.POSITIVE_INFINITY);
      const [e] = await q<{ waited: number }>(
        `SELECT extract(epoch FROM settled_at - first_observed_at)::float8 * 1000 AS waited FROM public.cache_invalidation_event
           WHERE tenant_id = $1::uuid AND source = 'tenant:UPDATE'`,
        id,
      );
      expect(e!.waited).toBeGreaterThanOrEqual(max + 5_000);
    } finally {
      await down.stop();
      await setMaxTtl(MAX_MS);
    }
  }, 60_000);

  it('[IO12] differing TTLs (A short, B the maximum; the relay has none of its own): expiry waits for the shared maximum, and B never serves the old value after it', async () => {
    const max = 3_000;
    await drain();
    const { id, host } = await newTenant();
    await drain();
    const a = await instance({ TENANT_CACHE_TTL_MS: '500' });
    const b = await instance({ TENANT_CACHE_TTL_MS: String(max) });
    const down = downRelay();
    await setMaxTtl(max);
    try {
      expect([await statusOn(a, host), await statusOn(b, host)]).toEqual(['ACTIVE', 'ACTIVE']);
      await x(`UPDATE public.tenant SET status = 'SUSPENDED' WHERE id = $1::uuid`, id);
      down.start();
      let expiredAt = 0;
      expect(
        await within(max + 10_000, async () => {
          const [e] = await q<{ status: string }>(
            `SELECT status FROM public.cache_invalidation_event WHERE tenant_id = $1::uuid AND source = 'tenant:UPDATE'`,
            id,
          );
          if (e?.status !== 'EXPIRED') return false;
          expiredAt = performance.now();
          return true;
        }),
      ).toBeLessThan(Number.POSITIVE_INFINITY);
      expect([await statusOn(a, host), await statusOn(b, host)]).toEqual([
        'SUSPENDED',
        'SUSPENDED',
      ]);
      expect(expiredAt).toBeGreaterThan(0);
      const [e] = await q<{ waited: number }>(
        `SELECT extract(epoch FROM settled_at - first_observed_at)::float8 * 1000 AS waited FROM public.cache_invalidation_event
           WHERE tenant_id = $1::uuid AND source = 'tenant:UPDATE'`,
        id,
      );
      expect(e!.waited).toBeGreaterThanOrEqual(max + 5_000);
    } finally {
      await down.stop();
      await setMaxTtl(MAX_MS);
    }
  }, 60_000);
});
