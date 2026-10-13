/**
 * Spec 0015 (cross-tenant suite, layer 5): products and key "forget" on the invalidation bus.
 * Prereqs: `pnpm dev:infra` (Valkey, Vault), `pnpm db:migrate && pnpm db:seed`.
 *
 * Processes: the harness's API app (instance 1) and worker, plus extra API instances and a CLI-like context
 * created per test. Key tests use scratch tenants (OFFBOARDING); product tests toggle demo's `helpdesk`.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FieldCrypto,
  keyProviderFrom,
  KeyUnavailableError,
  provisionTenantKey,
  rotateTenantKey,
  TenantKeyring,
} from '@univarse/crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig, type AppConfig } from '../../config/config.js';
import type { Actor } from '../../modules/identity/actor.js';
import { ProductService } from '../../modules/products/product.service.js';
import { AuditWriter } from '../audit/audit-writer.js';
import { createHarness, type Harness } from '../../testing/int-harness.js';
import type { TenantContext } from '../tenancy/tenant-resolver.service.js';
import { WorkerModule } from '../../worker.module.js';
import { KeyDestruction } from '../crypto/key-forget.js';
import { CHANNELS, InvalidationBus } from './invalidation-bus.js';

let h: Harness;
let config: AppConfig;
let shardId: string;
let actor: Actor;
let tenant: TenantContext;
const apps: INestApplication[] = [];
const contexts: INestApplicationContext[] = [];
const run = randomBytes(3).toString('hex');
const PRODUCT = 'helpdesk';
const meta = {
  ip: '203.0.113.15',
  userAgent: 'cache-isolation-test',
  requestId: 'req-cache-isolation',
};

const instance = async (env: Record<string, string> = {}) => {
  const app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', ...env }));
  apps.push(app);
  // Subscriptions are acknowledged before any test publishes: otherwise a message can race the SUBSCRIBE.
  // (Not for an instance whose Valkey is deliberately unreachable: its SUBSCRIBE can never be acknowledged.)
  if (!env.VALKEY_URL) await app.get(InvalidationBus).ready();
  return app;
};
/** A process like the `keys` CLI: the worker module, publishing but never subscribing. */
const cliContext = async (env: Record<string, string> = {}) => {
  const ctx = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(loadConfig({ ...process.env, NODE_ENV: 'test', ...env }), {
      subscribe: false,
    }),
    { logger: false },
  );
  contexts.push(ctx);
  return ctx;
};
const waitFor = async (check: () => Promise<boolean> | boolean, ms: number): Promise<number> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 25));
  }
  return Infinity;
};
/** Counts messages published on a channel, from a raw Valkey subscriber. */
async function listen(channel: string) {
  const sub = new Redis(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379');
  const seen: string[] = [];
  sub.on('message', (c: string, m: string) => c === channel && seen.push(m));
  await sub.subscribe(channel);
  return { seen, close: () => sub.disconnect() };
}
const zeroed = (b: Buffer) => b.every((x) => x === 0);

beforeAll(async () => {
  h = await createHarness();
  config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  shardId = (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId;
  const admin = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
  actor = {
    tenantId: h.tenants.demo,
    userId: admin.id,
    sessionId: 'cache-isolation',
    username: admin.username,
    displayName: 'Admin',
    mfaAt: new Date(),
    restricted: false,
    stepUpAt: new Date(),
    grants: [
      {
        permission: 'settings.product.manage',
        scopeType: 'INSTITUTION',
        scopeId: null,
        roleKey: 'INSTITUTION_ADMIN',
      },
    ],
  };
  tenant = {
    tenantId: h.tenants.demo,
    shardId,
    slug: 'demo-uni',
    shortName: 'DEMO',
    legalName: 'Demo',
    type: 'UNIVERSITY',
    status: 'ACTIVE',
  };
  await h.app.get(InvalidationBus).ready();
  await h.workerCtx.get(InvalidationBus).ready();
  await h.platform.tenantProduct.updateMany({
    where: { tenantId: h.tenants.demo, product: PRODUCT },
    data: { entitled: true, enabled: false },
  });
}, 60_000);

afterAll(async () => {
  await h.platform.tenantProduct.updateMany({
    where: { tenantId: h.tenants.demo, product: PRODUCT },
    data: { enabled: false },
  });
  for (const a of apps) await a.close();
  for (const c of contexts) await c.close();
  await h.close();
});

const toggle = async (enabled: boolean) =>
  h.app.get(ProductService).setEnabled(tenant, actor, PRODUCT, enabled, meta);

describe('[CI1][CI2][CI3][CI4] products on the bus', () => {
  it('[CI1][CI11] a toggle through instance 1 is served by instance 2, and honoured by the worker, within 2 s', async () => {
    const app2 = await instance();
    const p2 = app2.get(ProductService);
    const pw = h.workerCtx.get(ProductService);
    expect(await p2.isActive(h.tenants.demo, PRODUCT)).toBe(false); // both cache "off"
    expect(await pw.isActive(h.tenants.demo, PRODUCT)).toBe(false);
    await toggle(true);
    expect(await waitFor(() => p2.isActive(h.tenants.demo, PRODUCT), 2_000)).toBeLessThan(2_000);
    expect(await waitFor(() => pw.isActive(h.tenants.demo, PRODUCT), 2_000)).toBeLessThan(2_000);
    await toggle(false);
    expect(
      await waitFor(async () => !(await p2.isActive(h.tenants.demo, PRODUCT)), 2_000),
    ).toBeLessThan(2_000);
  });

  it('[CI1][CI10] the compensated path publishes too: a toggle whose audit write fails is undone, and a publish still follows', async () => {
    const listener = await listen(CHANNELS.products);
    try {
      const spy = vi
        .spyOn(h.app.get(AuditWriter), 'write')
        .mockRejectedValueOnce(new Error('injected audit failure'));
      await expect(toggle(true)).rejects.toThrow(/injected audit failure/);
      spy.mockRestore();
      // Compensated: the row is back where it was...
      expect(
        (
          await h.platform.tenantProduct.findFirstOrThrow({
            where: { tenantId: h.tenants.demo, product: PRODUCT },
          })
        ).enabled,
      ).toBe(false);
      // ...and the invalidation was still published, after the platform write and its compensation.
      expect(
        await waitFor(
          () =>
            listener.seen.some(
              (m) => (JSON.parse(m) as { tenantId: string }).tenantId === h.tenants.demo,
            ),
          2_000,
        ),
      ).toBeLessThan(2_000);
    } finally {
      listener.close();
    }
  });

  it('[CI2][CI11] with instance 2’s subscription down, the change is served within the (shortened) TTL', async () => {
    const app2 = await instance({ TENANT_CACHE_TTL_MS: '1500' });
    const p2 = app2.get(ProductService);
    expect(await p2.isActive(h.tenants.demo, PRODUCT)).toBe(false);
    app2.get(InvalidationBus).stopListening(); // the message never arrives
    await toggle(true);
    expect(await p2.isActive(h.tenants.demo, PRODUCT)).toBe(false); // still cached
    expect(await waitFor(() => p2.isActive(h.tenants.demo, PRODUCT), 3_000)).toBeLessThan(3_000);
    await toggle(false);
  });

  it('[CI3][CI11] a read that began before an eviction does not cache its (old) result', async () => {
    const app2 = await instance();
    const p2 = app2.get(ProductService);
    const bus2 = app2.get(InvalidationBus);
    await p2.invalidate(h.tenants.demo); // start uncached
    // Hold instance 2's DB read open, after it has read "off", until the eviction has arrived.
    const platform = (
      p2 as unknown as {
        platform: { tenantProduct: { findMany: (...a: unknown[]) => Promise<unknown> } };
      }
    ).platform;
    const real = platform.tenantProduct.findMany.bind(platform.tenantProduct);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let captured!: () => void;
    const oldResultCaptured = new Promise<void>((r) => (captured = r));
    const spy = vi
      .spyOn(platform.tenantProduct, 'findMany')
      .mockImplementationOnce(async (...a: unknown[]) => {
        const rows = await real(...a);
        captured(); // the old DB result is in hand
        await gate;
        return rows;
      });
    const inFlight = p2.isActive(h.tenants.demo, PRODUCT);
    await oldResultCaptured; // a signal, not a sleep: the read has captured the old row
    const before = bus2.received.get(CHANNELS.products) ?? 0;
    await toggle(true);
    expect(
      await waitFor(() => (bus2.received.get(CHANNELS.products) ?? 0) > before, 2_000),
    ).toBeLessThan(2_000);
    release();
    expect(await inFlight).toBe(false); // that read saw the old row, which is fine
    expect(await p2.isActive(h.tenants.demo, PRODUCT)).toBe(true); // but it wasn't cached
    spy.mockRestore();
    await toggle(false);
  });

  it('[CI4][CI11] with Valkey down, reads come from the DB, toggles commit, and publishing never throws or hangs', async () => {
    const app2 = await instance({ VALKEY_URL: 'redis://127.0.0.1:9' });
    const p2 = app2.get(ProductService);
    expect(await p2.isActive(h.tenants.demo, PRODUCT)).toBe(false);
    const started = Date.now();
    await p2.setEnabled(tenant, actor, PRODUCT, true, meta);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(
      (
        await h.platform.tenantProduct.findFirstOrThrow({
          where: { tenantId: h.tenants.demo, product: PRODUCT },
        })
      ).enabled,
    ).toBe(true);
    expect(await p2.isActive(h.tenants.demo, PRODUCT)).toBe(true);
    await toggle(false);
  });
});

// ---------------------------------------------------------------------------------------------- keys

const provider = () => keyProviderFrom(config);
async function scratchTenant(label: string): Promise<string> {
  const t = await h.platform.tenant.create({
    data: {
      slug: `cache-${label}-${run}`,
      legalName: `Cache ${label}`,
      shortName: `C-${label}`.toUpperCase(),
      type: 'UNIVERSITY',
      ownership: 'PRIVATE',
      status: 'OFFBOARDING',
      shardId,
    },
  });
  await provisionTenantKey(h.platform, provider(), t.id);
  return t.id;
}
/** The tenant's DEK (v1), unwrapped and cached in this process's keyring; the buffer is the cached one. */
const cachedKey = (ctx: INestApplicationContext, tenantId: string) =>
  ctx.get(TenantKeyring).key(tenantId, 1);

describe('[CI5][CI6] key forget on the bus', () => {
  it('[CI5][CI11] after shredding, an API instance and the worker drop and zero the DEK within 2 s; decrypts then fail', async () => {
    const t = await scratchTenant('shred');
    const app2 = await instance();
    const sealed = await app2.get(FieldCrypto).encrypt(t, Buffer.from('secret'), `${t}:x`);
    const apiKey = await cachedKey(app2, t);
    const workerKey = await cachedKey(h.workerCtx, t);
    const cli = await cliContext();
    const { destroyed, report } = await cli
      .get(KeyDestruction)
      .shredTenantKeys(t, null, 'cache isolation test');
    expect(destroyed).toBe(1);
    expect(report!.receivers).toBeGreaterThanOrEqual(2);
    expect(await waitFor(() => zeroed(apiKey) && zeroed(workerKey), 2_000)).toBeLessThan(2_000);
    await expect(app2.get(FieldCrypto).decrypt(t, sealed, `${t}:x`)).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
    await expect(h.workerCtx.get(FieldCrypto).decrypt(t, sealed, `${t}:x`)).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
  });

  it('[CI6][CI11] a lost forget is bounded by the keyring deadline: the key is evicted and zeroed without any message or lookup', async () => {
    const t = await scratchTenant('lost');
    const app2 = await instance({ DEK_CACHE_TTL_MS: '1500' });
    const key = await cachedKey(app2, t);
    app2.get(InvalidationBus).stopListening();
    const cli = await cliContext();
    await cli.get(KeyDestruction).shredTenantKeys(t, null, 'cache isolation test');
    expect(zeroed(key)).toBe(false); // the message never arrived
    expect(await waitFor(() => zeroed(key), 3_000)).toBeLessThan(3_000);
  });

  it('[CI6][CI11] the fallback deadline is the shared one-hour ceiling, not the sender’s TTL: a receiver with a longer TTL and a lost notice still holds the key past the sender’s TTL', async () => {
    const t = await scratchTenant('ttl');
    const receiver = await instance(); // the default DEK TTL: one hour
    const key = await cachedKey(receiver, t);
    receiver.get(InvalidationBus).stopListening(); // its notice is lost
    const sender = await cliContext({ DEK_CACHE_TTL_MS: '1000' }); // a CLI configured with a 1 s TTL
    const before = Date.now();
    const { report } = await sender
      .get(KeyDestruction)
      .shredTenantKeys(t, null, 'cache isolation test');
    const deadline = report!.fallbackDeadline.getTime();
    expect(deadline - before).toBeGreaterThanOrEqual(60 * 60_000 - 5_000); // destruction time + 1 h, not + 1 s
    expect(deadline - before).toBeLessThanOrEqual(60 * 60_000 + 5_000);
    expect(report!.lines.join('\n')).toMatch(/60 min ceiling on any key-cache TTL/);
    await new Promise((r) => setTimeout(r, 1_500)); // past the SENDER's TTL
    expect(zeroed(key)).toBe(false); // the receiver still holds it: a sender-TTL deadline would have been false
    receiver.get(TenantKeyring).forget(t); // tidy: don't leave the destroyed key cached for an hour
  });

  it('[CI6][CI11] with Valkey unavailable, destruction finishes within the bound and reports delivery unconfirmed', async () => {
    const t = await scratchTenant('noval');
    const cli = await cliContext({ VALKEY_URL: 'redis://127.0.0.1:9' });
    const started = Date.now();
    const { destroyed, report } = await cli
      .get(KeyDestruction)
      .shredTenantKeys(t, null, 'cache isolation test');
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(destroyed).toBe(1);
    expect(report!.receivers).toBeNull();
    const text = report!.lines.join('\n');
    expect(text).toMatch(/delivery unconfirmed/);
    expect(text).toMatch(
      /fallback deadline: every process drops the destroyed key by \d{4}-\d\d-\d\dT/,
    );
    expect(text).toMatch(/restart the API and the worker/);
    expect(text).not.toMatch(/forgot\b(?! )|subscribers forgot/);
  });

  it('[CI6][CI9][CI11] the real `keys destroy-retired` CLI, with Valkey down, exits 0 within the bound and says delivery is unconfirmed', async () => {
    const t = await scratchTenant('cli');
    await rotateTenantKey(h.platform, provider(), t, null);
    await h.platform.tenantDataKey.update({
      where: { tenantId_version: { tenantId: t, version: 1 } },
      data: { retiredAt: new Date(Date.now() - 2 * 60 * 60_000) },
    });
    const slug = (await h.platform.tenant.findUniqueOrThrow({ where: { id: t } })).slug;
    const apiDir = fileURLToPath(new URL('../../../', import.meta.url));
    const started = Date.now();
    const r = spawnSync(
      process.execPath,
      [
        '--enable-source-maps',
        'dist/cli/keys.js',
        'destroy-retired',
        slug,
        '1',
      ] /* exactly what `pnpm keys` runs (CI builds first) */,
      {
        cwd: apiDir,
        env: { ...process.env, NODE_ENV: 'test', VALKEY_URL: 'redis://127.0.0.1:9' },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r.stdout).toMatch(/v1 destroyed/);
    expect(r.stdout).toMatch(/delivery unconfirmed/);
    expect(r.stdout).toMatch(/fallback deadline/);
    expect(r.stdout).toMatch(/restart the API and the worker/);
    expect(
      (
        await h.platform.tenantDataKey.findUniqueOrThrow({
          where: { tenantId_version: { tenantId: t, version: 1 } },
        })
      ).status,
    ).toBe('DESTROYED');
  });
});

describe('[CI8] the messages themselves are isolated', () => {
  it("[CI8][CI11] A's product invalidation and A's key forget leave B's cached products and DEK untouched", async () => {
    const a = await scratchTenant('iso-a');
    const b = await scratchTenant('iso-b');
    const app2 = await instance();
    const p2 = app2.get(ProductService);
    await p2.isActive(b, PRODUCT); // B's products cached
    const bKey = await cachedKey(app2, b);
    const platform = (
      p2 as unknown as { platform: { tenantProduct: { findMany: (...x: unknown[]) => unknown } } }
    ).platform;
    const reads = vi.spyOn(platform.tenantProduct, 'findMany');
    const bus2 = app2.get(InvalidationBus);
    const before = {
      p: bus2.received.get(CHANNELS.products) ?? 0,
      k: bus2.received.get(CHANNELS.keysForget) ?? 0,
    };
    await h.app.get(ProductService).invalidate(a);
    await (await cliContext()).get(KeyDestruction).shredTenantKeys(a, null, 'cache isolation test');
    // Both messages must actually have arrived, or "B untouched" below would prove nothing.
    expect(
      await waitFor(
        () =>
          (bus2.received.get(CHANNELS.products) ?? 0) > before.p &&
          (bus2.received.get(CHANNELS.keysForget) ?? 0) > before.k,
        2_000,
      ),
    ).toBeLessThan(2_000);
    await p2.isActive(b, PRODUCT);
    expect(reads).not.toHaveBeenCalled(); // B served from its cache: no extra DB read
    expect(zeroed(bKey)).toBe(false);
    expect(await cachedKey(app2, b)).toBe(bKey); // the same cached buffer: no extra unwrap
    reads.mockRestore();
  });

  it('[CI8][CI11] a malformed message is ignored and logged; channels are fixed constants', async () => {
    const app2 = await instance();
    const bus2 = app2.get(InvalidationBus);
    const before = bus2.received.get(CHANNELS.keysForget) ?? 0;
    const raw = new Redis(process.env.VALKEY_URL ?? 'redis://127.0.0.1:6379');
    for (const m of [
      'not json',
      JSON.stringify({ tenantId: 'nope' }),
      JSON.stringify({ tenantId: h.tenants.demo, extra: 'x' }),
    ])
      await raw.publish(CHANNELS.keysForget, m);
    raw.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    expect(bus2.received.get(CHANNELS.keysForget) ?? 0).toBe(before);
    expect(Object.values(CHANNELS)).toEqual([
      'uv:products:invalidate',
      'uv:keys:forget',
      'uv:tenants:invalidate',
    ]);
  });
});

describe('[CI9] destruction notifies after commit only', () => {
  it('[CI9][CI11] a refused, a rolled-back and a no-op destruction publish nothing', async () => {
    const listener = await listen(CHANNELS.keysForget);
    try {
      const cli = await cliContext();
      const destruction = cli.get(KeyDestruction);
      // Refused: destroy-retired on an ACTIVE key throws before anything is destroyed (the CLI then never notifies).
      const refused = await scratchTenant('refused');
      const { destroyRetiredKey } = await import('@univarse/crypto');
      await expect(
        destroyRetiredKey(h.platform, refused, 1, () => Promise.resolve(0), {
          actorId: null,
          reason: 'test',
        }),
      ).rejects.toMatchObject({ why: 'not_retired' });
      // Rolled back: the destruction transaction fails after its update.
      const rolled = await scratchTenant('rollback');
      const realPlatform = (destruction as unknown as { platform: typeof h.platform }).platform;
      const failing = new Proxy(realPlatform, {
        get: (target, prop) =>
          prop === '$transaction'
            ? (fn: (tx: unknown) => Promise<unknown>) =>
                target.$transaction(async (tx) => {
                  await fn(tx);
                  throw new Error('injected failure after the update');
                })
            : Reflect.get(target, prop),
      });
      (destruction as unknown as { platform: unknown }).platform = failing;
      await expect(destruction.shredTenantKeys(rolled, null, 'test')).rejects.toThrow(
        /injected failure/,
      );
      (destruction as unknown as { platform: unknown }).platform = realPlatform;
      expect(
        (
          await h.platform.tenantDataKey.findUniqueOrThrow({
            where: { tenantId_version: { tenantId: rolled, version: 1 } },
          })
        ).status,
      ).toBe('ACTIVE');
      // No-op: nothing left to destroy.
      const noop = await scratchTenant('noop');
      await destruction.shredTenantKeys(noop, null, 'first');
      // Wait for that real destruction's message to arrive before counting, so a late delivery isn't misread.
      expect(await waitFor(() => listener.seen.length === 1, 2_000)).toBeLessThan(2_000);
      const seenAfterFirst = listener.seen.length;
      expect((await destruction.shredTenantKeys(noop, null, 'again')).report).toBeNull();
      await new Promise((r) => setTimeout(r, 300));
      expect(listener.seen.length).toBe(seenAfterFirst);
      // The only message seen is the one real destruction (noop's first shred).
      expect(listener.seen.map((m) => (JSON.parse(m) as { tenantId: string }).tenantId)).toEqual([
        noop,
      ]);
    } finally {
      listener.close();
    }
  });
});
