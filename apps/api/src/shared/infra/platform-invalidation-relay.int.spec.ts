/**
 * Spec 0016: the platform invalidation relay against real Postgres (the relay's own role, from .env.worker) and,
 * where a test says so, real Valkey and two API instances. Prereqs: `pnpm dev:infra`, `pnpm db:setup`,
 * `pnpm db:migrate && pnpm db:seed`. No worker may be running: its relay would claim these events too.
 *
 * Each test first drains whatever is pending (with a publish that only records), so it starts with no backlog.
 * Fixtures are a shard and tenants of its own, written as the migrator and deleted (their events settled) after.
 * The capture triggers themselves are tested in packages/db/test/cache-invalidation.int.spec.ts.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { relayUrl } from '../../testing/relay-env.js';
import { CHANNELS, InvalidationBus, type Channel, type PublishResult } from './invalidation-bus.js';
import {
  PlatformInvalidationRelay,
  type PublishFn,
  type RelayOptions,
  type RelayPass,
} from './platform-invalidation-relay.js';
import {
  BATCH_DEADLINE_MS,
  PURGE_BATCH,
  PURGE_INTERVAL_MS,
  RELAY_TX_TIMEOUT_MS,
} from './relay-policy.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379';

let mig: PlatformClient; // univarse_migrator: fixtures and observations
let shardId: string;
const tenants = new Set<string>();
const relays: PlatformInvalidationRelay[] = [];
const redises: Redis[] = [];
const apps: INestApplication[] = [];

const q = <T = unknown>(sql: string, ...params: unknown[]) =>
  mig.$queryRawUnsafe<T[]>(sql, ...params);
const x = (sql: string, ...params: unknown[]) => mig.$executeRawUnsafe(sql, ...params);
const dbNow = async () => (await q<{ at: Date }>(`SELECT clock_timestamp() AS at`))[0]!.at;

const DELIVERED: PublishResult = { delivered: true, receivers: 0 };
const recordOnly: PublishFn = () => Promise.resolve(DELIVERED);

const relay = (publish: PublishFn, options: RelayOptions = {}) => {
  const r = new PlatformInvalidationRelay(createPlatformClient(relayUrl()), publish, options);
  relays.push(r);
  return r;
};
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
/** A publishing bus on real Valkey, connected before it is used (its client never queues offline). */
const liveBus = async () => new InvalidationBus(await ready(redis()), false);

/** Settles everything pending, so a test starts with no backlog. */
async function drain(): Promise<void> {
  const r = relay(recordOnly);
  for (let i = 0; i < 100; i++) if ((await r.runOnce()).claimed === 0) return;
  throw new Error('backlog did not drain');
}

async function newTenant(): Promise<string> {
  const slug = `ir-${randomBytes(6).toString('hex')}`;
  const [row] = await q<{ id: string }>(
    `INSERT INTO public.tenant (slug, legal_name, short_name, type, ownership, shard_id, updated_at)
     VALUES ($1, 'Relay Test Polytechnic', 'RTP', 'POLYTECHNIC', 'STATE', $2::uuid, now()) RETURNING id::text`,
    slug,
    shardId,
  );
  const id = row!.id;
  await x(
    `INSERT INTO public.tenant_domain (tenant_id, hostname, kind) VALUES ($1::uuid, $2, 'SUBDOMAIN')`,
    id,
    `${slug}.relay.test`,
  );
  await x(
    `INSERT INTO public.tenant_product (tenant_id, product, updated_at) VALUES ($1::uuid, 'core', now())`,
    id,
  );
  tenants.add(id);
  return id;
}

/** One products event per tenant per call (a committed change to its tenant_product row). */
const bump = (...ids: string[]) =>
  x(
    `UPDATE public.tenant_product SET entitled = NOT entitled WHERE tenant_id = ANY($1::uuid[])`,
    ids,
  );

interface EventState {
  id: string;
  tenantId: string;
  channel: string;
  status: string;
  attempts: number;
  due: Date;
  observed: Date | null;
  lastError: string | null;
}
const eventsOf = (...ids: string[]) =>
  q<EventState>(
    `SELECT id::text, tenant_id::text AS "tenantId", channel, status, attempts, next_attempt_at AS due,
            first_observed_at AS observed, last_error AS "lastError"
     FROM public.cache_invalidation_event WHERE tenant_id = ANY($1::uuid[]) ORDER BY next_attempt_at, id`,
    ids,
  );
const pendingOf = async (...ids: string[]) =>
  (await eventsOf(...ids)).filter((e) => e.status === 'PENDING');

/** Terminates the relay backend that is idle inside a transaction (the one paused in a hook), as the relay role. */
async function killPausedRelay(): Promise<number> {
  const c = createPlatformClient(relayUrl());
  try {
    const r = await c.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
       WHERE usename = current_user AND pid <> pg_backend_pid() AND state = 'idle in transaction'`,
    );
    return r.filter((row) => row.ok).length;
  } finally {
    await c.$disconnect();
  }
}

beforeAll(async () => {
  mig = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  const [shard] = await q<{ id: string }>(
    `INSERT INTO public.shard (name, kind, secret_ref, region) VALUES ($1, 'POOL', 'RELAY_TEST_DATABASE_URL', 'local') RETURNING id::text`,
    `relay-test-${randomBytes(4).toString('hex')}`,
  );
  shardId = shard!.id;
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await Promise.all(relays.map((r) => r.onApplicationShutdown()));
  for (const r of redises) r.disconnect();
  await x(`DELETE FROM public.tenant WHERE id = ANY($1::uuid[])`, [...tenants]);
  await x(`DELETE FROM public.shard WHERE id = $1::uuid`, shardId);
  // Settle what this suite left, as the owner, so no relay inherits it.
  await x(
    `UPDATE public.cache_invalidation_event SET status = 'PUBLISHED' WHERE status = 'PENDING' AND tenant_id = ANY($1::uuid[])`,
    [...tenants],
  );
  await mig.$disconnect();
});

describe('[IO7] only committed events, published inside the claiming transaction', () => {
  it('[IO7] an uncommitted change is not claimable; once committed it is claimed, published, and settled in the same transaction', async () => {
    const t = await newTenant();
    await drain();
    let commit!: () => void;
    const commitGate = new Promise<void>((r) => (commit = r));
    let changed!: () => void;
    const didChange = new Promise<void>((r) => (changed = r));
    // A writer whose change stays uncommitted until the test lets it go.
    const writing = mig.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE public.tenant_product SET entitled = NOT entitled WHERE tenant_id = $1::uuid`,
          t,
        );
        changed();
        await commitGate;
      },
      { timeout: 10_000 },
    );
    await didChange;
    const published: string[] = [];
    let eventId = '';
    let statusDuringPublish = '';
    const r = relay(async (_c, tenantId) => {
      published.push(tenantId);
      statusDuringPublish = (await eventsOf(t)).find((e) => e.id === eventId)?.status ?? 'missing';
      return DELIVERED;
    });
    expect((await r.runOnce()).claimed).toBe(0);
    commit();
    await writing;
    eventId = (await pendingOf(t))[0]!.id;
    const pass = await r.runOnce();
    expect(pass).toMatchObject({ claimed: 1, published: 1, publishes: 1, end: 'done' });
    expect(published).toEqual([t]);
    // While it publishes, the event is still PENDING to everyone else: the settlement commits with the claim.
    expect(statusDuringPublish).toBe('PENDING');
    expect((await eventsOf(t)).find((e) => e.id === eventId)?.status).toBe('PUBLISHED');
  });
});

describe('[IO8][IO9] crashes leave events pending: at least once to Valkey', () => {
  it('[IO8] a relay killed after claiming and before publishing releases its locks; another publishes the event', async () => {
    const t = await newTenant();
    await drain();
    await bump(t);
    const published: string[] = [];
    const pub: PublishFn = (_c, tenantId) => (published.push(tenantId), Promise.resolve(DELIVERED));
    let killed = 0;
    // A crash: the connection dies, and so does the process's pass (killing the connection alone wouldn't stop
    // the JavaScript from publishing before its next statement failed).
    const a = relay(pub, {
      afterClaim: async () => {
        killed = await killPausedRelay();
        throw new Error('simulated crash before publishing');
      },
    });
    await expect(a.runOnce()).rejects.toThrow();
    expect(killed).toBe(1);
    expect(published).toEqual([]);
    expect((await pendingOf(t)).map((e) => e.attempts)).toEqual([0]);
    expect(await relay(pub).runOnce()).toMatchObject({ claimed: 1, published: 1, end: 'done' });
    expect(published).toEqual([t]);
    expect(await pendingOf(t)).toEqual([]);
  });

  it('[IO9] a relay killed after publishing and before committing leaves the event pending; it is published again, harmlessly', async () => {
    const t = await newTenant();
    await drain();
    await bump(t);
    const bus = await liveBus();
    const sub = await ready(redis());
    const seen: string[] = [];
    sub.on('message', (_c: string, m: string) => seen.push(m));
    await sub.subscribe(CHANNELS.products);
    const publish: PublishFn = (c, tenantId, ms) => bus.publish(c, tenantId, ms);
    const a = relay(publish, {
      beforeCommit: async () => {
        await killPausedRelay();
      },
    });
    await expect(a.runOnce()).rejects.toThrow();
    expect((await pendingOf(t)).map((e) => e.attempts)).toEqual([0]);
    expect(await relay(publish).runOnce()).toMatchObject({ claimed: 1, published: 1, end: 'done' });
    await expect.poll(() => seen.filter((m) => m.includes(t)).length).toBe(2);
    // The duplicate is the same message: a second eviction of the same tenant, with no event id to track.
    expect(new Set(seen.filter((m) => m.includes(t)))).toEqual(
      new Set([JSON.stringify({ tenantId: t })]),
    );
  });
});

describe('[IO10] concurrent relays', () => {
  it('[IO10] each event is claimed by exactly one relay per pass (SKIP LOCKED), and every event is published', async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, () => newTenant()));
    await drain();
    for (let i = 0; i < 10; i++) await bump(...ids); // 250 events: more than one batch
    const backlog = (await pendingOf(...ids)).map((e) => e.id);
    expect(backlog).toHaveLength(250);
    const claims = { a: [] as string[], b: [] as string[] };
    let aClaimed!: () => void;
    const aHolds = new Promise<void>((r) => (aClaimed = r));
    const slow: PublishFn = async () => (await sleep(20), DELIVERED);
    const a = relay(slow, {
      afterClaim: (c) => {
        claims.a.push(...c);
        aClaimed();
      },
    });
    const b = relay(slow, {
      afterClaim: (c) => {
        claims.b.push(...c);
      },
    });
    const runA = a.runOnce();
    await aHolds; // A holds its 200 locks while it publishes
    const [passA, passB] = await Promise.all([runA, b.runOnce()]);
    expect([passA.claimed, passB.claimed]).toEqual([200, 50]);
    expect(claims.a.filter((id) => claims.b.includes(id))).toEqual([]);
    expect(new Set([...claims.a, ...claims.b])).toEqual(new Set(backlog));
    expect(await pendingOf(...ids)).toEqual([]);
  });
});

describe('[IO11] the pass is bounded: deadline, budget, failure', () => {
  it('[IO11] a publish that outlasts the clipped budget is deadline exhaustion: the event stays pending, attempts and due time unchanged', async () => {
    const t = await newTenant();
    await drain();
    await bump(t);
    const [before] = await pendingOf(t);
    // The real bus, on a client whose PUBLISH never answers: it times out on the budget it is given.
    const hanging = new InvalidationBus(
      { publish: () => new Promise<number>(() => undefined) } as unknown as Redis,
      false,
    );
    const budgets: number[] = [];
    const started = performance.now();
    const pass = await relay(
      (c, tenantId, ms) => (budgets.push(ms), hanging.publish(c, tenantId, ms)),
    ).runOnce();
    expect(pass).toMatchObject({
      claimed: 1,
      published: 0,
      possibleDuplicates: 1,
      retried: 0,
      end: 'deadline',
    });
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeLessThanOrEqual(BATCH_DEADLINE_MS);
    expect(performance.now() - started).toBeLessThan(RELAY_TX_TIMEOUT_MS);
    const [after] = await pendingOf(t);
    expect(after).toMatchObject({ id: before!.id, attempts: 0, lastError: null });
    expect(after!.due.getTime()).toBe(before!.due.getTime());
  });

  it('[IO11] Valkey down: the first failed publish stops the pass, the rest back off; published once Valkey returns', async () => {
    const ids = await Promise.all([newTenant(), newTenant(), newTenant()]);
    await drain();
    await bump(...ids);
    const down = new InvalidationBus(redis('redis://127.0.0.1:1'), false);
    const up = await liveBus();
    let target = down;
    let calls = 0;
    const r = relay((c, tenantId, ms) => (calls++, target.publish(c, tenantId, ms)), {
      random: () => 0.5,
    });
    const marker = await dbNow();
    expect(await r.runOnce()).toMatchObject({
      claimed: 3,
      published: 0,
      retried: 3,
      end: 'failure',
    });
    expect(calls).toBe(1);
    const backedOff = await pendingOf(...ids);
    expect(backedOff.map((e) => [e.attempts, e.lastError])).toEqual([
      [1, 'PublishFailed'],
      [1, 'PublishFailed'],
      [1, 'PublishFailed'],
    ]);
    // 250 ms for a first retry (jitter pinned to the middle), from the database's clock at the failure.
    for (const e of backedOff) {
      expect(e.due.getTime() - marker.getTime()).toBeGreaterThanOrEqual(250);
      expect(e.due.getTime() - marker.getTime()).toBeLessThan(250 + 1_000);
    }
    expect((await r.runOnce()).claimed).toBe(0); // not due yet
    target = up;
    await sleep(300);
    expect(await r.runOnce()).toMatchObject({
      claimed: 3,
      published: 3,
      publishes: 3,
      end: 'done',
    });
    const retried = new Set(backedOff.map((e) => e.id));
    expect(
      (await eventsOf(...ids)).filter((e) => retried.has(e.id)).map((e) => [e.status, e.attempts]),
    ).toEqual([
      ['PUBLISHED', 1],
      ['PUBLISHED', 1],
      ['PUBLISHED', 1],
    ]);
  });

  it('[IO11] backlog: 500 events over 100 tenants on both channels drain FIFO, each pass settles ≥ m and lasts ≤ T, within ceil(500 ÷ m) × T', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(await newTenant());
    await drain();
    // 500 events, interleaved: tenant i % 100; the tenants channel when i % 3 = 0, else products. Tenants repeat
    // inside a batch (on both channels, and as the same pair) and across batch boundaries.
    await x(
      `DO $$ DECLARE ids uuid[] := '{${ids.join(',')}}'::uuid[]; t uuid; BEGIN
           FOR i IN 0..499 LOOP
             t := ids[(i % 100) + 1];
             IF i % 3 = 0 THEN UPDATE public.tenant SET short_name = CASE short_name WHEN 'RTP' THEN 'RTQ' ELSE 'RTP' END WHERE id = t;
             ELSE UPDATE public.tenant_product SET entitled = NOT entitled WHERE tenant_id = t; END IF;
           END LOOP; END $$`,
    );
    const backlog = await pendingOf(...ids);
    expect(backlog).toHaveLength(500);
    const pairs = new Set(backlog.map((e) => `${e.channel}|${e.tenantId}`));

    // Each publish takes 100 ms, or times out on a smaller budget, like the bus.
    const firstDue: number[] = [];
    const publish: PublishFn = async (channel: Channel, tenantId, ms) => {
      if (ms < 100) return (await sleep(ms), { delivered: false, reason: 'publish timed out' });
      const due = q<{ due: Date }>(
        `SELECT min(next_attempt_at) AS due FROM public.cache_invalidation_event
           WHERE status = 'PENDING' AND channel = $1 AND tenant_id = $2::uuid`,
        channel,
        tenantId,
      );
      await sleep(100);
      firstDue.push((await due)[0]!.due.getTime());
      return DELIVERED;
    };
    const passes: { pass: RelayPass; at: number }[] = [];
    let done!: () => void;
    const drained = new Promise<void>((r) => (done = r));
    const started = performance.now();
    const r = relay(publish, {
      onPass: (pass) => {
        passes.push({ pass, at: performance.now() });
        if (pass.claimed === 0) done();
      },
    });
    const m = 10;
    const T = RELAY_TX_TIMEOUT_MS + 250;
    const bound = Math.ceil(500 / m) * T;
    r.start();
    // Waits no longer than the bound (plus a second), so a relay that can't drain fails on it, not on a timeout.
    await Promise.race([drained, sleep(bound + 1_000)]);
    const drainMs = performance.now() - started;
    await r.stop();

    const working = passes.filter((p) => p.pass.claimed > 0);
    for (const p of working) expect(p.pass.durationMs).toBeLessThan(RELAY_TX_TIMEOUT_MS);
    for (const p of working.slice(0, -1)) expect(p.pass.published).toBeGreaterThanOrEqual(m);
    for (let i = 1; i < passes.length; i++)
      expect(passes[i]!.at - passes[i - 1]!.at).toBeLessThanOrEqual(T);
    expect(drainMs).toBeLessThanOrEqual(bound);
    // FIFO by due time: each publish's oldest event is no older than the previous publish's.
    for (let i = 1; i < firstDue.length; i++)
      expect(firstDue[i]!).toBeGreaterThanOrEqual(firstDue[i - 1]!);
    const inBacklog = new Set(backlog.map((e) => e.id));
    const after = (await eventsOf(...ids)).filter((e) => inBacklog.has(e.id));
    expect(after.filter((e) => e.status !== 'PUBLISHED' || e.attempts !== 0)).toEqual([]);
    const P = working.reduce((n, p) => n + p.pass.publishes, 0);
    const D = working.reduce((n, p) => n + p.pass.possibleDuplicates, 0);
    expect(P).toBeGreaterThanOrEqual(pairs.size);
    expect(P).toBeLessThanOrEqual(500);
    process.stdout.write(
      `
[IO11] backlog drained in ${String(Math.round(drainMs))} ms over ${String(working.length)} passes; ` +
        `P=${String(P)}, D=${String(D)}, distinct pairs=${String(pairs.size)}, bound ${String(bound)} ms
`,
    );
  }, 200_000);

  it('[IO11] healthy, no backlog: 20 sequential changes each reach both API instances within 2 s of commit', async () => {
    const t = await newTenant();
    await drain();
    const one = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
    apps.push(one);
    const two = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test' }));
    apps.push(two);
    const buses = [one.get(InvalidationBus), two.get(InvalidationBus)];
    await Promise.all(buses.map((b) => b.ready()));
    const bus = await liveBus();
    const r = relay((c, tenantId, ms) => bus.publish(c, tenantId, ms));
    r.start();
    const received = () => buses.map((b) => b.received.get(CHANNELS.products) ?? 0);
    const latencies: number[] = [];
    try {
      for (let i = 0; i < 20; i++) {
        const before = received();
        await bump(t);
        const committed = performance.now();
        while (received().some((n, k) => n <= before[k]!) && performance.now() - committed < 5_000)
          await sleep(5);
        latencies.push(performance.now() - committed);
      }
    } finally {
      await r.stop();
    }
    process.stdout.write(`
[IO11] healthy commit → both instances: max ${String(Math.round(Math.max(...latencies)))} ms over 20 changes
`);
    for (const ms of latencies) expect(ms).toBeLessThan(2_000);
  }, 60_000);
});

describe('[IO12] the first observation is stamped by the database, after commit', () => {
  it('[IO12] a relay paused after BEGIN claims, in that same transaction, an event committed meanwhile; first_observed_at is after the commit', async () => {
    const t = await newTenant();
    await drain();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pausedNow!: () => void;
    const paused = new Promise<void>((r) => (pausedNow = r));
    const claimed: string[] = [];
    const r = relay(recordOnly, {
      afterBegin: async () => {
        pausedNow();
        await gate;
      },
      afterClaim: (c) => {
        claimed.push(...c);
      },
    });
    const run = r.runOnce();
    await paused;
    await bump(t); // committed while the relay's transaction is open, before its claim is sent
    const [event] = await pendingOf(t);
    const marker = await dbNow();
    release();
    expect(await run).toMatchObject({ claimed: 1, published: 1 });
    expect(claimed).toEqual([event!.id]);
    const [after] = (await eventsOf(t)).filter((e) => e.id === event!.id);
    expect(after!.observed!.getTime()).toBeGreaterThanOrEqual(marker.getTime());
    expect(after!.due.getTime()).toBe(event!.due.getTime());
  });
});

describe('[IO18] fairness and housekeeping', () => {
  it('[IO18] a due retry is published in the first pass after it falls due, though fresh events outnumber a batch', async () => {
    const retry = await newTenant();
    const busy = await newTenant();
    await drain();
    await bump(retry);
    const failOnce = relay((_c, tenantId) =>
      Promise.resolve(
        tenantId === retry
          ? { delivered: false as const, reason: 'Connection is closed.' }
          : DELIVERED,
      ),
    );
    expect(await failOnce.runOnce()).toMatchObject({ claimed: 1, retried: 1, end: 'failure' });
    const [r1] = await pendingOf(retry);
    // Wait until it is due, by the database's clock.
    while ((await dbNow()).getTime() < r1!.due.getTime() + 100) await sleep(50);
    // 300 fresh events, all after the retry fell due: more than one batch of 200.
    await x(
      `DO $$ BEGIN FOR i IN 1..300 LOOP
         UPDATE public.tenant_product SET entitled = NOT entitled WHERE tenant_id = '${busy}'; END LOOP; END $$`,
    );
    const claimed: string[] = [];
    const pass = await relay(recordOnly, {
      afterClaim: (c) => {
        claimed.push(...c);
      },
    }).runOnce();
    expect(pass.claimed).toBe(200);
    expect(claimed[0]).toBe(r1!.id);
    expect(await pendingOf(retry)).toEqual([]);
    await drain();
  });

  it('[IO18] housekeeping runs at most once a minute, deleting at most 1 000 settled events per run', async () => {
    const t = randomUUID();
    tenants.add(t);
    await x(
      `INSERT INTO public.cache_invalidation_event (channel, tenant_id, source, status, settled_at)
       SELECT 'uv:products:invalidate', $1::uuid, 'tenant_product:UPDATE', 'PUBLISHED', clock_timestamp() - interval '25 hours'
       FROM generate_series(1, $2::int)`,
      t,
      PURGE_BATCH + 1,
    );
    let now = 0;
    const r = relay(recordOnly, { now: () => now });
    expect(await r.housekeep()).toBe(PURGE_BATCH);
    now += PURGE_INTERVAL_MS - 1;
    expect(await r.housekeep()).toBeNull();
    now += 1;
    expect(await r.housekeep()).toBeGreaterThanOrEqual(1);
    expect(await eventsOf(t)).toEqual([]);
  });
});

describe('[IO17] only the worker holds the relay role credentials', () => {
  it('[IO17] after db:setup the root .env (the API development preload) lacks PLATFORM_RELAY_URL; .env.worker holds it; the API refuses it', () => {
    const root = parseEnv(readFileSync(rootEnv, 'utf8'));
    const worker = parseEnv(
      readFileSync(new URL('../../../../../.env.worker', import.meta.url), 'utf8'),
    );
    expect(Object.keys(root).filter((k) => k.includes('RELAY'))).toEqual([]);
    expect(Object.keys(worker).sort()).toEqual([
      'PGBOUNCER_PLATFORM_RELAY_URL',
      'PLATFORM_RELAY_URL',
    ]);
    // What the API loads in development starts; plus the worker's file, it refuses (without echoing the value).
    const preload = { ...process.env, ...root, NODE_ENV: 'test' };
    expect(loadConfig(preload).PLATFORM_RELAY_URL).toBeUndefined();
    let refusal = '';
    try {
      loadConfig({ ...preload, ...worker });
    } catch (err) {
      refusal = (err as Error).message;
    }
    expect(refusal).toMatch(/PLATFORM_RELAY_URL: set, but only the worker may hold the relay role/);
    expect(refusal).not.toContain(worker.PLATFORM_RELAY_URL!);
  });
});
