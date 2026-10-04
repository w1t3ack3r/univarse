/**
 * Spec 0003 — product entitlements, through the real app and databases.
 * Every AC ID appears in a test name. Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running.
 * Seeded plans: demo-uni is entitled to admissions/bursary/academics/helpdesk (none enabled);
 * test-poly to admissions. Every test restores that state.
 */
import { forTenant } from '@univarse/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditWriter } from '../../shared/audit/audit-writer.js';
import { createHarness, HOSTS, PASSWORD, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { base32Decode } from '../identity/totp.js';

let h: Harness;
const D = HOSTS.demo;
const P = HOSTS.poly;

const sessionOf = (res: InjectResult): string => {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
  return all.find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
};

const row = (tenant: 'demo' | 'poly', product: string) =>
  h.platform.tenantProduct.findUnique({ where: { tenantId_product: { tenantId: h.tenants[tenant], product } } });
const setRow = (tenant: 'demo' | 'poly', product: string, data: { entitled?: boolean; enabled?: boolean }) =>
  h.platform.tenantProduct.update({ where: { tenantId_product: { tenantId: h.tenants[tenant], product } }, data });
const auditFor = (tenant: 'demo' | 'poly', entityId: string) =>
  forTenant(h.shard, h.tenants[tenant]).auditEvent.findMany({ where: { entityType: 'tenant_product', entityId }, orderBy: { seq: 'asc' } });

const put = (cookie: string, product: string, body: unknown, host: string = D) =>
  h.call('PUT', host, `/api/v1/admin/products/${product}`, { cookie, body });

/** An Institution Admin with MFA, logged in on `host`. */
async function admin(tenant: 'demo' | 'poly' = 'demo') {
  const host = HOSTS[tenant];
  const u = await h.makeUser(tenant, { role: 'INSTITUTION_ADMIN' });
  const restricted = sessionOf(await h.login(host, u.username));
  const begin = await h.call('POST', host, '/api/v1/auth/mfa/totp/enrol', { cookie: restricted, body: { password: PASSWORD } });
  expect(begin.statusCode).toBe(200);
  const secret = base32Decode(begin.json().secret);
  const confirm = await h.call('POST', host, '/api/v1/auth/mfa/totp/confirm', { cookie: restricted, body: { code: totpCode(secret) } });
  expect(confirm.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants[tenant], u.id);
  return { ...u, host, tenant, secret, session: sessionOf(confirm) };
}

/** Same admin after a step-up (new session cookie). */
async function steppedUp(a: Awaited<ReturnType<typeof admin>>) {
  const res = await h.call('POST', a.host, '/api/v1/auth/step-up', { cookie: a.session, body: { password: PASSWORD, code: totpCode(a.secret) } });
  expect(res.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants[a.tenant], a.id);
  return sessionOf(res);
}

let demoAdmin: string; // stepped-up session
let polyAdmin: string;

beforeAll(async () => {
  h = await createHarness();
  demoAdmin = await steppedUp(await admin('demo'));
  polyAdmin = await steppedUp(await admin('poly'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of ['admissions', 'bursary', 'academics', 'helpdesk']) await setRow('demo', p, { entitled: true, enabled: false });
  await setRow('poly', 'admissions', { entitled: true, enabled: false });
  await h.platform.tenantProduct.deleteMany({ where: { tenantId: h.tenants.demo, product: 'reporting' } });
});
afterAll(async () => {
  await h.close();
});

describe('[P1] entitled AND enabled = active', () => {
  it('[P1] only core is active until an entitled product is also enabled', async () => {
    const student = sessionOf(await h.login(D, (await h.makeUser('demo', { role: 'STUDENT' })).username));
    const list = async () => (await h.call('GET', D, '/api/v1/products', { cookie: student })).json().data;

    expect(await list()).toEqual(['core']); // entitled to admissions, not enabled
    expect((await put(demoAdmin, 'admissions', { enabled: true })).statusCode).toBe(200);
    expect(await list()).toEqual(['admissions', 'core']);

    await setRow('demo', 'admissions', { entitled: false, enabled: false }); // plan revoked by the platform
    h.app.get((await import('./product.service.js')).ProductService).invalidate(h.tenants.demo);
    expect(await list()).toEqual(['core']);
  });

  it('[P1] the database refuses enabled-without-entitled and unknown products', async () => {
    await expect(setRow('demo', 'admissions', { entitled: false, enabled: true })).rejects.toThrow();
    await expect(
      h.platform.tenantProduct.create({ data: { tenantId: h.tenants.demo, product: 'casino', entitled: true } }),
    ).rejects.toThrow();
  });
});

describe('[P4] IT Admin switches products within the plan', () => {
  it('[P4] enables and disables an entitled product', async () => {
    const on = await put(demoAdmin, 'bursary', { enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ product: 'bursary', entitled: true, enabled: true, active: true });
    expect((await row('demo', 'bursary'))?.enabled).toBe(true);

    const off = await put(demoAdmin, 'bursary', { enabled: false });
    expect(off.json()).toEqual({ product: 'bursary', entitled: true, enabled: false, active: false });
    expect((await row('demo', 'bursary'))?.enabled).toBe(false);
  });

  it('[P4] a product outside the plan → 409 product.not_entitled, nothing written', async () => {
    const res = await put(demoAdmin, 'reporting', { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('product.not_entitled');
    expect(await row('demo', 'reporting')).toBeNull();
  });

  it('[P4] core cannot be disabled → 422 product.core_required', async () => {
    const res = await put(demoAdmin, 'core', { enabled: false });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('product.core_required');
  });

  it('[P4] unknown product → 404; malformed body → 400', async () => {
    expect((await put(demoAdmin, 'casino', { enabled: true })).statusCode).toBe(404);
    expect((await put(demoAdmin, 'bursary', { enabled: 'yes' })).statusCode).toBe(400);
  });

  it('[P4] unauthorized callers are refused: anonymous 401, non-admin 403, no MFA 403, no step-up 428', async () => {
    expect((await put('', 'bursary', { enabled: true })).statusCode).toBe(401);

    const lecturer = sessionOf(await h.login(D, (await h.makeUser('demo', { role: 'LECTURER' })).username));
    expect((await put(lecturer, 'bursary', { enabled: true })).json().code).toBe('auth.forbidden');

    const fresh = await admin('demo'); // MFA session, but no step-up yet
    const res = await put(fresh.session, 'bursary', { enabled: true });
    expect(res.statusCode).toBe(428);
    expect(res.json().code).toBe('auth.step_up_required');
    expect((await row('demo', 'bursary'))?.enabled).toBe(false);
  });
});

describe('[P5] audited', () => {
  it('[P5] each change writes one tenant audit event with before/after; a no-op writes none', async () => {
    const id = (await row('demo', 'academics'))!.id;
    const before = (await auditFor('demo', id)).length;

    await put(demoAdmin, 'academics', { enabled: true });
    await put(demoAdmin, 'academics', { enabled: true }); // no-op
    await put(demoAdmin, 'academics', { enabled: false });

    const events = (await auditFor('demo', id)).slice(before);
    expect(events.map((e) => e.action)).toEqual(['settings.product.enabled', 'settings.product.disabled']);
    expect(events[0]).toMatchObject({
      actorType: 'USER',
      before: { product: 'academics', enabled: false },
      after: { product: 'academics', enabled: true },
    });
    expect(events[0]!.actorId).toBeTruthy();
  });

  it('[P5] if the audit write fails, the platform change is compensated and the request fails', async () => {
    const id = (await row('demo', 'helpdesk'))!.id;
    const before = (await auditFor('demo', id)).length;
    vi.spyOn(h.app.get(AuditWriter), 'write').mockRejectedValueOnce(new Error('shard unavailable'));

    const res = await put(demoAdmin, 'helpdesk', { enabled: true });
    expect(res.statusCode).toBe(500);
    expect((await row('demo', 'helpdesk'))?.enabled).toBe(false); // no unaudited change remains
    expect((await auditFor('demo', id)).length).toBe(before);

    const student = sessionOf(await h.login(D, (await h.makeUser('demo', { role: 'STUDENT' })).username));
    expect((await h.call('GET', D, '/api/v1/products', { cookie: student })).json().data).toEqual(['core']);
  });
});

describe('[P6] visible to clients', () => {
  it('[P6] admin overview lists every catalog product with flags', async () => {
    const res = await h.call('GET', D, '/api/v1/admin/products', { cookie: demoAdmin });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { product: string; entitled: boolean; enabled: boolean; active: boolean }[];
    expect(data.map((d) => d.product)).toEqual(['core', 'admissions', 'bursary', 'academics', 'teaching', 'assessment', 'student_affairs', 'helpdesk', 'reporting']);
    expect(data.find((d) => d.product === 'core')).toEqual({ product: 'core', entitled: true, enabled: true, active: true });
    expect(data.find((d) => d.product === 'bursary')).toEqual({ product: 'bursary', entitled: true, enabled: false, active: false });
    expect(data.find((d) => d.product === 'teaching')).toEqual({ product: 'teaching', entitled: false, enabled: false, active: false });
  });

  it('[P6] the active list needs a session; the overview needs the permission', async () => {
    expect((await h.call('GET', D, '/api/v1/products')).statusCode).toBe(401);
    const student = sessionOf(await h.login(D, (await h.makeUser('demo', { role: 'STUDENT' })).username));
    expect((await h.call('GET', D, '/api/v1/admin/products', { cookie: student })).statusCode).toBe(403);
  });
});

describe('[P7] cache', () => {
  it('[P7] a change is visible immediately on the instance that made it', async () => {
    const student = sessionOf(await h.login(D, (await h.makeUser('demo', { role: 'STUDENT' })).username));
    const list = async () => (await h.call('GET', D, '/api/v1/products', { cookie: student })).json().data;
    expect(await list()).toEqual(['core']); // primes the cache
    await put(demoAdmin, 'admissions', { enabled: true });
    expect(await list()).toEqual(['admissions', 'core']);
    await put(demoAdmin, 'admissions', { enabled: false });
    expect(await list()).toEqual(['core']);
  });
});

describe('[P8] tenant-scoped', () => {
  it('[P8] an admin changes only their own institution; another tenant is untouched', async () => {
    expect((await put(polyAdmin, 'admissions', { enabled: true }, P)).statusCode).toBe(200);
    expect((await row('poly', 'admissions'))?.enabled).toBe(true);
    expect((await row('demo', 'admissions'))?.enabled).toBe(false);
  });

  it('[P8] a session from one tenant is not accepted on another tenant host', async () => {
    expect((await put(demoAdmin, 'admissions', { enabled: true }, P)).statusCode).toBe(401);
    expect((await row('poly', 'admissions'))?.enabled).toBe(false);
  });

  it("[P8] another tenant's plan is not visible: poly's overview shows only poly's entitlements", async () => {
    const data = (await h.call('GET', P, '/api/v1/admin/products', { cookie: polyAdmin })).json().data as { product: string; entitled: boolean }[];
    expect(data.filter((d) => d.entitled).map((d) => d.product)).toEqual(['core', 'admissions']);
  });
});

describe('[P9] only the platform sets entitlements', () => {
  it('[P9] the tenant endpoint rejects any attempt to set entitled', async () => {
    const res = await put(demoAdmin, 'reporting', { enabled: true, entitled: true });
    expect(res.statusCode).toBe(400);
    expect(await row('demo', 'reporting')).toBeNull();
  });
});
