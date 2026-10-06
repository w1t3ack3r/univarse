/**
 * Spec 0007 — tenant settings, one typed key end to end. Every AC ID appears in a test name.
 * Prereqs: `pnpm db:migrate && pnpm db:seed` (new permissions), Valkey running.
 * Academics is enabled for demo-uni for this file (the key belongs to it) and restored afterwards.
 */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SETTINGS, UnitLimits, type SettingDef } from '@univarse/contracts';
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { createHarness, HOSTS, PASSWORD, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import type { TenantContext } from '../../shared/tenancy/tenant-resolver.service.js';
import type { Actor } from '../identity/actor.js';
import { base32Decode } from '../identity/totp.js';
import { SettingsCache } from './settings-cache.js';
import { SettingsService, type SettingsRegistry } from './settings.service.js';

const KEY = 'registration.unitLimits';
/** A key outside registration, managed by `settings.tenant.manage` (proves D3 scoping). */
const OTHER = 'test.institutionThing';
const REGISTRY: SettingsRegistry = {
  ...SETTINGS,
  [OTHER]: {
    schema: z.object({ on: z.boolean() }).strict(),
    default: { on: false },
    scopes: ['INSTITUTION'],
    product: 'core',
    manage: 'settings.tenant.manage',
    effectiveDated: false,
    sensitive: true,
    label: 'Test',
  } satisfies SettingDef,
};

let h: Harness;
const D = HOSTS.demo;
const P = HOSTS.poly;
const run = randomBytes(3).toString('hex');
const apps: NestFastifyApplication[] = [];

const sessionOf = (res: InjectResult): string => {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
  return all.find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
};

interface Person {
  id: string;
  host: string;
  tenant: 'demo' | 'poly';
  secret: Buffer;
  session: string;
}

/** A user of `role` with MFA, signed in on `host`. */
async function person(role: string, tenant: 'demo' | 'poly' = 'demo'): Promise<Person> {
  const host = HOSTS[tenant];
  const u = await h.makeUser(tenant, { role });
  const restricted = sessionOf(await h.login(host, u.username));
  const begin = await h.call('POST', host, '/api/v1/auth/mfa/totp/enrol', { cookie: restricted, body: { password: PASSWORD } });
  expect(begin.statusCode).toBe(200);
  const secret = base32Decode(begin.json().secret);
  const confirm = await h.call('POST', host, '/api/v1/auth/mfa/totp/confirm', { cookie: restricted, body: { code: totpCode(secret) } });
  expect(confirm.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants[tenant], u.id);
  return { id: u.id, host, tenant, secret, session: sessionOf(confirm) };
}

async function steppedUp(p: Person): Promise<string> {
  const res = await h.call('POST', p.host, '/api/v1/auth/step-up', { cookie: p.session, body: { password: PASSWORD, code: totpCode(p.secret) } });
  expect(res.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants[p.tenant], p.id);
  return sessionOf(res);
}

const get = (cookie: string, key = KEY, host: string = D) => h.call('GET', host, `/api/v1/settings/${key}`, { cookie });
const put = (cookie: string, value: unknown, etag: string | undefined, key = KEY, host: string = D) =>
  h.call('PUT', host, `/api/v1/settings/${key}`, { cookie, body: { value }, ...(etag ? { headers: { 'if-match': etag } } : {}) });
const del = (cookie: string, etag: string | undefined, key = KEY, host: string = D) =>
  h.call('DELETE', host, `/api/v1/settings/${key}`, { cookie, ...(etag ? { headers: { 'if-match': etag } } : {}) });
const audits = (entityId: string) =>
  forTenant(h.shard, h.tenants.demo).auditEvent.findMany({ where: { entityType: 'setting', entityId }, orderBy: { seq: 'asc' } });
const settingRow = (tenant: 'demo' | 'poly' = 'demo', key = KEY) =>
  forTenant(h.shard, h.tenants[tenant]).setting.findUnique({ where: { tenantId_key_scopeKey: { tenantId: h.tenants[tenant], key, scopeKey: 'INSTITUTION' } } });
const academics = (enabled: boolean) =>
  h.platform.tenantProduct.update({ where: { tenantId_product: { tenantId: h.tenants.demo, product: 'academics' } }, data: { enabled } });

/** A second API instance on the same DB and Valkey (another pod in production). */
async function instance(env: Record<string, string> = {}) {
  // Not checked against the OpenAPI document (spec 0011 OA10): this app serves a test-only settings
  // registry, which the production document does not describe.
  const app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', ...env }), { settingsRegistry: REGISTRY });
  apps.push(app);
  return app;
}
const demoRef = () => ({ tenantId: h.tenants.demo, shardId: shardId });
let shardId: string;

let registrar: Person;
let registrarUp: string; // stepped-up session
let admin: Person;
let adminUp: string;

beforeAll(async () => {
  h = await createHarness();
  await academics(true); // before any instance caches the tenant's products
  shardId = (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId;
  registrar = await person('REGISTRAR');
  registrarUp = await steppedUp(registrar);
  admin = await person('INSTITUTION_ADMIN');
  adminUp = await steppedUp(admin);
  h.app.get(SettingsService); // fail fast if not wired
}, 60_000);
afterAll(async () => {
  for (const a of apps) await a.close();
  await academics(false);
  await h.close();
});

/** The current ETag of the key, as the Registrar sees it. */
async function etag(key = KEY, cookie = registrarUp): Promise<string> {
  const res = await get(cookie, key);
  expect(res.statusCode).toBe(200);
  return String(res.headers.etag);
}

describe('[ST1][ST2] typed registry and defaults', () => {
  it('[ST1] an unregistered key is 404 settings.unknown_key on every endpoint', async () => {
    for (const res of [await get(registrarUp, 'nope.key'), await put(registrarUp, 1, '"v0"', 'nope.key'), await del(registrarUp, '"v0"', 'nope.key')]) {
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('settings.unknown_key');
    }
  });

  it('[ST1] stored rows for unregistered keys are ignored by reads', async () => {
    const db = forTenant(h.shard, h.tenants.demo);
    const orphan = await db.setting.create({ data: { tenantId: h.tenants.demo, key: `gone.${run}`, value: { x: 1 } } });
    try {
      const res = await h.call('GET', D, '/api/v1/settings', { cookie: registrarUp });
      expect(res.statusCode).toBe(200);
      const keys = res.json().data.map((v: { key: string }) => v.key);
      expect(keys).toContain(KEY);
      expect(keys).not.toContain(`gone.${run}`); // the orphan row is ignored
    } finally {
      await db.setting.delete({ where: { id: orphan.id } });
    }
  });

  it('[ST1] the API and the web form validate with the same schema from contracts', () => {
    expect(SETTINGS[KEY].schema).toBe(UnitLimits);
    expect(UnitLimits.safeParse({ min: 15, max: 24 }).success).toBe(true);
  });

  it('[ST2] with no override the default is returned with source "default", and reading writes nothing', async () => {
    // Registrar resets to the default first (the seeded tenant may carry earlier runs' overrides).
    await del(registrarUp, await etag());
    const before = await settingRow();
    const res = await get(registrarUp);
    expect(res.json()).toMatchObject({ key: KEY, value: { min: 15, max: 24 }, default: { min: 15, max: 24 }, source: 'default' });
    expect(await settingRow()).toEqual(before);

    const app2 = await instance();
    const svc = app2.get(SettingsService);
    expect(await svc.get(demoRef(), KEY)).toEqual({ min: 15, max: 24 }); // ST12 consumer contract
  });
});

describe('[ST3][ST4][ST5] validation and authorisation', () => {
  it('[ST3] invalid values are refused with field-level errors and change nothing', async () => {
    const tag = await etag();
    for (const [value, path] of [
      [{ min: 25, max: 24 }, 'max'],
      [{ min: 0, max: 24 }, 'min'],
      [{ min: 15, max: 61 }, 'max'],
      [{ min: 15.5, max: 24 }, 'min'],
    ] as const) {
      const res = await put(registrarUp, value, tag);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe('settings.invalid_value');
      expect(res.json().errors.map((e: { path: string }) => e.path)).toContain(path);
    }
    expect(await put(registrarUp, { min: 15, max: 24, extra: 1 }, tag).then((r) => r.statusCode)).toBe(422);
    expect(await etag()).toBe(tag);
  });

  it('[ST3] a stored value that no longer validates fails closed (500), never silently becomes the default', async () => {
    const app2 = await instance({ SETTINGS_CACHE_TTL_MS: '0' });
    const db = forTenant(h.shard, h.tenants.demo);
    const row = await settingRow();
    const good = row?.value ?? null;
    await db.setting.update({ where: { id: row!.id }, data: { value: { min: 30, max: 10 } } });
    try {
      await expect(app2.get(SettingsService).get(demoRef(), KEY)).rejects.toMatchObject({ code: 'settings.stored_value_invalid', status: 500 });
    } finally {
      await db.setting.update({ where: { id: row!.id }, data: { value: good ?? { min: 15, max: 24 } } });
    }
  });

  it('[ST4] the Registrar (settings.registration.manage) needs a fresh step-up to write', async () => {
    const fresh = await person('REGISTRAR'); // MFA, but no step-up on this session
    const res = await put(fresh.session, { min: 16, max: 24 }, await etag());
    expect(res.statusCode).toBe(428);
    expect(res.json().code).toBe('auth.step_up_required');
  });

  it('[ST4] a key of a product the tenant has not active is 404 (test-poly has no Academics)', async () => {
    const poly = await person('REGISTRAR', 'poly');
    const up = await steppedUp(poly);
    expect((await get(up, KEY, P)).statusCode).toBe(404);
    expect((await put(up, { min: 15, max: 24 }, '"v0"', KEY, P)).statusCode).toBe(404);
  });

  it('[ST5] the admin oversees (reads, sees who changed it) but cannot write a registration key', async () => {
    const res = await get(adminUp);
    expect(res.statusCode).toBe(200);
    expect(res.json().canManage).toBe(false);
    const write = await put(adminUp, { min: 16, max: 24 }, String(res.headers.etag));
    expect(write.statusCode).toBe(403);
  });

  it('[ST5] the Registrar cannot write a non-registration key (narrow permission, D3)', async () => {
    const app2 = await instance();
    const inject = (method: 'PUT' | 'GET', cookie: string) =>
      app2.getHttpAdapter().getInstance().inject({
        method,
        url: `/api/v1/settings/${OTHER}`,
        remoteAddress: '203.0.113.9',
        headers: { host: D, cookie, 'sec-fetch-site': 'same-origin', 'if-match': '"v0"' },
        ...(method === 'PUT' ? { payload: { value: { on: true } } } : {}),
      });
    expect((await inject('GET', registrarUp)).json().canManage).toBe(false);
    expect((await inject('PUT', registrarUp)).statusCode).toBe(403);
  });

  it('[ST5] users without settings.tenant.view cannot read settings', async () => {
    const lecturer = await h.makeUser('demo', { role: 'LECTURER' });
    const s = sessionOf(await h.login(D, lecturer.username));
    expect((await get(s)).statusCode).toBe(403);
  });
});

describe('[ST6][ST7][ST8] concurrency, reset and audit', () => {
  it('[ST6] writes need If-Match: missing is 428, stale is 412, and neither changes anything', async () => {
    const tag = await etag();
    expect((await put(registrarUp, { min: 16, max: 24 }, undefined)).json().code).toBe('precondition.required');
    const ok = await put(registrarUp, { min: 16, max: 24 }, tag);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).not.toBe(tag);
    const stale = await put(registrarUp, { min: 17, max: 24 }, tag);
    expect(stale.statusCode).toBe(412);
    expect(stale.json().code).toBe('precondition.failed');
    expect((await get(registrarUp)).json().value).toEqual({ min: 16, max: 24 });
  });

  it('[ST7] reset returns to the default and keeps counting versions (an old ETag never matches again)', async () => {
    const v1 = await etag();
    await put(registrarUp, { min: 18, max: 26 }, v1);
    const afterUpdate = await etag();
    const reset = await del(registrarUp, afterUpdate);
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ source: 'default', value: { min: 15, max: 24 } });
    const afterReset = String(reset.headers.etag);
    expect(new Set([v1, afterUpdate, afterReset]).size).toBe(3);
    expect((await put(registrarUp, { min: 20, max: 24 }, afterUpdate)).statusCode).toBe(412);
  });

  it('[ST8] update and reset are audited in the same transaction, with before/after and versions', async () => {
    const tag = await etag();
    const res = await put(registrarUp, { min: 19, max: 25 }, tag);
    const row = await settingRow();
    const events = await audits(row!.id);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ action: 'settings.updated', actorId: registrar.id });
    expect(last.after).toMatchObject({ key: KEY, value: { min: 19, max: 25 }, version: res.json().version });
    expect(last.before).toMatchObject({ key: KEY, version: res.json().version - 1 });
  });

  it('[ST8] if the audit write fails, the change rolls back', async () => {
    const tag = await etag();
    const before = (await get(registrarUp)).json().value;
    const { AuditWriter } = await import('../../shared/audit/audit-writer.js');
    const spy = vi.spyOn(h.app.get(AuditWriter), 'write').mockRejectedValueOnce(new Error('audit down'));
    try {
      expect((await put(registrarUp, { min: 21, max: 27 }, tag)).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await get(registrarUp)).json().value).toEqual(before);
    expect(await etag()).toBe(tag);
  });

  it('[ST8] a sensitive key is redacted in audit', async () => {
    const app2 = await instance();
    const res = await app2.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: `/api/v1/settings/${OTHER}`,
      remoteAddress: '203.0.113.10',
      headers: { host: D, cookie: adminUp },
    });
    const write = await app2.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: `/api/v1/settings/${OTHER}`,
      remoteAddress: '203.0.113.10',
      headers: { host: D, cookie: adminUp, 'sec-fetch-site': 'same-origin', 'if-match': String(res.headers.etag) },
      payload: { value: { on: !res.json().value.on } },
    });
    expect(write.statusCode).toBe(200);
    const row = await settingRow('demo', OTHER);
    expect((await audits(row!.id)).at(-1)!.after).toMatchObject({ value: '[redacted]' });
  });
});

describe('[ST9][ST10] tenant isolation, including the cache', () => {
  it('[ST9] tenant B’s host never returns or changes tenant A’s setting', async () => {
    // demo's Registrar session on poly's host is not a session there.
    expect((await get(registrarUp, KEY, P)).statusCode).toBe(401);
    expect((await put(registrarUp, { min: 15, max: 24 }, '"v0"', KEY, P)).statusCode).toBe(401);
  });

  it('[ST10] cache keys are tenant-scoped: same key, different tenants, never cross', async () => {
    // test-poly can't use the Academics key, so prove it on the core test key with two tenants' overrides.
    const app2 = await instance();
    const svc = app2.get(SettingsService);
    const polyRef = { tenantId: h.tenants.poly, shardId };
    const polyRow = await forTenant(h.shard, h.tenants.poly).setting.upsert({
      where: { tenantId_key_scopeKey: { tenantId: h.tenants.poly, key: OTHER, scopeKey: 'INSTITUTION' } },
      create: { tenantId: h.tenants.poly, key: OTHER, value: { on: true }, version: 1 },
      update: { value: { on: true } },
    });
    const demoNow = (await svc.get(demoRef(), OTHER as never)) as { on: boolean };
    expect(await svc.get(polyRef, OTHER as never)).toEqual({ on: true });
    // A change for demo evicts only demo's entry.
    const cache = app2.get(SettingsCache);
    const polyGen = cache.generation(`settings:${h.tenants.poly}:INSTITUTION:${OTHER}`);
    await cache.publish({ tenantId: h.tenants.demo, scopeKey: 'INSTITUTION', key: OTHER, version: 99 });
    expect(cache.generation(`settings:${h.tenants.poly}:INSTITUTION:${OTHER}`)).toBe(polyGen);
    expect(cache.get(`settings:${h.tenants.poly}:INSTITUTION:${OTHER}`)).toBeDefined();
    expect(await svc.get(demoRef(), OTHER as never)).toEqual(demoNow);
    await forTenant(h.shard, h.tenants.poly).setting.delete({ where: { id: polyRow.id } });
  });
});

describe('[ST11] cross-instance freshness', () => {
  const waitFor = async (check: () => Promise<boolean>, ms: number) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await check()) return Date.now() - start;
      await new Promise((r) => setTimeout(r, 25));
    }
    return Infinity;
  };

  it('[ST11a] an update through instance 1 is served by instance 2 within 2 s', async () => {
    const app2 = await instance();
    const svc = app2.get(SettingsService);
    const cached = await svc.get(demoRef(), KEY); // instance 2 caches the current value
    const next = { min: cached.min === 15 ? 14 : 15, max: 24 };
    expect((await put(registrarUp, next, await etag())).statusCode).toBe(200);
    const took = await waitFor(async () => isDeepStrictEqual({ ...(await svc.get(demoRef(), KEY)) }, next), 2_000);
    expect(took).toBeLessThan(2_000);
  });

  it('[ST11b] with instance 2’s subscription lost, it is served within the TTL', async () => {
    const app2 = await instance({ SETTINGS_CACHE_TTL_MS: '1500' });
    const svc = app2.get(SettingsService);
    const cached = await svc.get(demoRef(), KEY);
    await app2.get(SettingsCache).stopListening(); // the message never arrives
    const next = { min: cached.min === 15 ? 13 : 15, max: 24 };
    expect((await put(registrarUp, next, await etag())).statusCode).toBe(200);
    expect(await svc.get(demoRef(), KEY)).toEqual(cached); // still the old value, from cache
    const took = await waitFor(async () => isDeepStrictEqual({ ...(await svc.get(demoRef(), KEY)) }, next), 3_000);
    expect(took).toBeLessThan(3_000);
  });

  it('[ST11c] a read that began before the change does not re-cache the old value', async () => {
    const app2 = await instance();
    const svc = app2.get(SettingsService);
    const cache = app2.get(SettingsCache);
    cache.evict(`settings:${h.tenants.demo}:INSTITUTION:${KEY}`); // start uncached
    // Hold instance 2's load after it has read the DB, until the invalidation has arrived.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const proto = Object.getPrototypeOf(svc) as { load: (...a: unknown[]) => Promise<unknown> };
    const realLoad = proto.load;
    const loadSpy = vi.spyOn(svc as unknown as { load: (...a: unknown[]) => Promise<unknown> }, 'load').mockImplementationOnce(async function (this: unknown, ...a: unknown[]) {
      const value = await realLoad.apply(svc, a);
      await gate;
      return value;
    });
    const before = (await get(registrarUp)).json().value as { min: number; max: number };
    const inFlight = svc.get(demoRef(), KEY);
    await new Promise((r) => setTimeout(r, 200)); // the load has read the old row
    const received = cache.received;
    const next = { min: before.min === 15 ? 12 : 15, max: 24 };
    expect((await put(registrarUp, next, await etag())).statusCode).toBe(200);
    await waitFor(async () => Promise.resolve(cache.received > received), 2_000);
    release();
    expect(await inFlight).toEqual(before); // that read saw the old row, which is fine
    expect(await svc.get(demoRef(), KEY)).toEqual(next); // but it wasn't cached
    loadSpy.mockRestore();
  });

  it('[ST11d] with Valkey down, reads come from the DB and writes still commit', async () => {
    const app2 = await instance({ VALKEY_URL: 'redis://127.0.0.1:9' });
    const svc = app2.get(SettingsService);
    expect(await svc.get(demoRef(), KEY)).toEqual((await get(registrarUp)).json().value);
    // A write on the Valkey-less instance (service level: sign-in itself rate-limits through Valkey).
    const actor: Actor = {
      tenantId: h.tenants.demo,
      userId: registrar.id,
      sessionId: 'st11d',
      username: 'st11d',
      displayName: 'Registrar',
      mfaAt: new Date(),
      restricted: false,
      stepUpAt: new Date(),
      grants: [{ permission: 'settings.registration.manage', scopeType: 'INSTITUTION', scopeId: null, roleKey: 'REGISTRAR' }],
    };
    const tenant: TenantContext = { tenantId: h.tenants.demo, shardId, slug: 'demo-uni', shortName: 'DEMO', legalName: 'Demo', type: 'UNIVERSITY', status: 'ACTIVE' };
    const current = (await get(registrarUp)).json();
    const next = { min: current.value.min === 15 ? 11 : 15, max: 24 };
    const view = await svc.update(tenant, actor, KEY, next, `"v${String(current.version)}"`, { ip: '203.0.113.11', userAgent: 'test', requestId: 'req-st11d-test' });
    expect(view.value).toEqual(next);
    // Committed: the row has it, and this instance serves it. (Instance 1 converges within its TTL,
    // since this instance could not publish the invalidation; that is the D2 worst case.)
    expect((await settingRow())?.value).toEqual(next);
    expect(await svc.get(demoRef(), KEY)).toEqual(next);
  });
});
