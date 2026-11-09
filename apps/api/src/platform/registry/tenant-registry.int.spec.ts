/**
 * Spec 0033: the tenant registry against the real platform database, as the console role, through the platform API's own
 * HTTP stack. The console role can't create an institution, so the scratch ones are made by the migrator, and removed
 * again. The database is shared, so each has a slug of its own and no test assumes it holds the only one.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../modules/identity/password.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { PlatformSessions } from '../identity/sessions.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PASSWORD = 'Correct-Horse-Battery-9';
const HOST = 'console.univarse.localhost';
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';

let app: NestFastifyApplication;
let db: PlatformClient;
let migrator: PlatformClient;
const staffIds = new Set<string>();
const tenantIds = new Set<string>();
const sessions = new Map<Role, string>();

interface Res {
  status: number;
  body: Record<string, unknown>;
  raw: string;
  headers: Record<string, unknown>;
}

async function call(method: 'GET' | 'PUT' | 'DELETE', url: string, opts: { cookie?: string; body?: unknown; ifMatch?: string } = {}): Promise<Res> {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/platform/v1${url}`,
      remoteAddress: `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`,
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.ifMatch ? { 'if-match': opts.ifMatch } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    /* an image, or nothing */
  }
  return { status: res.statusCode, body, raw: res.body, headers: res.headers };
}

/** A member with a full session, stepped up unless told otherwise. */
async function session(role: Role, stepUp = true): Promise<string> {
  const email = `reg-${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  const { id } = await db.platformUser.create({ data: { email, displayName: `Reg ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  staffIds.add(id);
  const now = new Date();
  const { token } = await db.$transaction((tx) => app.get(PlatformSessions).create(tx, id, { ip: '127.0.0.1', userAgent: 'test' }, { mfaAt: now, restricted: false, stepUpAt: stepUp ? now : null }));
  return `__Host-uv_console_sid=${token}`;
}
const as = async (role: Role) => {
  let s = sessions.get(role);
  if (!s) sessions.set(role, (s = await session(role)));
  return s;
};

async function scratch(over: { status?: 'ACTIVE' | 'ONBOARDING' | 'ARCHIVED'; legalName?: string } = {}) {
  const shard = await migrator.shard.findFirstOrThrow({ select: { id: true } });
  const tag = randomBytes(5).toString('hex');
  const slug = `reg-${tag}`;
  const t = await migrator.tenant.create({
    data: { slug, legalName: over.legalName ?? `Registry Test ${tag}`, shortName: `R${tag}`.toUpperCase(), type: 'UNIVERSITY', ownership: 'PRIVATE', status: over.status ?? 'ACTIVE', shardId: shard.id },
    select: { id: true, slug: true, legalName: true, shortName: true },
  });
  tenantIds.add(t.id);
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: `${slug}.reg.test`, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await migrator.tenantProduct.create({ data: { tenantId: t.id, product: 'admissions', entitled: true, enabled: true } });
  return t;
}

const profile = (t: { legalName: string; shortName: string }, over: object = {}) => ({ legalName: t.legalName, shortName: t.shortName, ownership: 'PRIVATE', type: 'UNIVERSITY', ...over });

function png(width = 64, height = 64, length = 64): string {
  const b = Buffer.alloc(length);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

const auditFor = (tenantId: string) => db.platformAuditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' }, select: { action: true, metadata: true, actorId: true } });

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), {});
  db = app.get(CONSOLE_DB);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
});
beforeEach(() => undefined);
afterAll(async () => {
  await db.platformSession.updateMany({ where: { userId: { in: [...staffIds] }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await db.platformUser.updateMany({ where: { id: { in: [...staffIds] } }, data: { role: 'READ_ONLY', isActive: false } });
  await migrator.tenant.deleteMany({ where: { id: { in: [...tenantIds] } } });
  await migrator.$disconnect();
  await app.close();
});

describe('[Q1] who may do what', () => {
  it('every role reads; only OWNER and SUPER_ADMIN change anything, and to anyone else the route is absent', async () => {
    const t = await scratch();
    for (const role of ['OWNER', 'SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
      expect([role, (await call('GET', `/tenants/${t.id}`, { cookie: await as(role) })).status]).toEqual([role, 200]);
    }
    for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
      const cookie = await as(role);
      expect([role, (await call('PUT', `/tenants/${t.id}`, { cookie, ifMatch: '"v0"', body: profile(t) })).status]).toEqual([role, 404]);
      expect([role, (await call('PUT', `/tenants/${t.id}/products/bursary`, { cookie, body: { entitled: true, reason: 'because I said' } })).status]).toEqual([role, 404]);
      expect([role, (await call('PUT', `/tenants/${t.id}/branding/color`, { cookie, body: { primaryColor: '#1A3A6B' } })).status]).toEqual([role, 404]);
    }
  });

  it('a change needs a fresh step-up; signed out is refused', async () => {
    const t = await scratch();
    const cold = await session('OWNER', false);
    expect((await call('PUT', `/tenants/${t.id}`, { cookie: cold, ifMatch: '"v0"', body: profile(t) })).body.code).toBe('auth.step_up_required');
    expect((await call('PUT', `/tenants/${t.id}/products/bursary`, { cookie: cold, body: { entitled: true, reason: 'because I said' } })).body.code).toBe('auth.step_up_required');
    expect((await call('GET', '/tenants')).status).toBe(401);
  });
});

describe('[Q2, Q8] the list and search', () => {
  it('pages stably by name, and filters', async () => {
    const stem = `Paging ${randomBytes(4).toString('hex')}`;
    for (const n of ['A', 'B', 'C']) await scratch({ legalName: `${stem} ${n}` });
    const cookie = await as('READ_ONLY');
    const first = await call('GET', `/tenants?q=${encodeURIComponent(stem)}&limit=2`, { cookie });
    const rows = first.body.data as { legalName: string }[];
    expect(rows.map((r) => r.legalName)).toEqual([`${stem} A`, `${stem} B`]);
    const cursor = (first.body.page as { nextCursor: string }).nextCursor;
    const next = await call('GET', `/tenants?q=${encodeURIComponent(stem)}&limit=2&cursor=${cursor}`, { cookie });
    expect((next.body.data as { legalName: string }[]).map((r) => r.legalName)).toEqual([`${stem} C`]);
    expect((next.body.page as { hasMore: boolean }).hasMore).toBe(false);
    expect(((await call('GET', `/tenants?q=${encodeURIComponent(stem)}&status=SUSPENDED`, { cookie })).body.data as unknown[]).length).toBe(0);
  });

  it('finds by legal name, short name, slug and hostname, in any case', async () => {
    const t = await scratch();
    const cookie = await as('READ_ONLY');
    for (const q of [t.legalName.toUpperCase(), t.shortName.toLowerCase(), t.slug, `${t.slug}.reg.test`]) {
      const ids = ((await call('GET', `/tenants?q=${encodeURIComponent(q)}`, { cookie })).body.data as { id: string }[]).map((r) => r.id);
      expect([q, ids]).toEqual([q, [t.id]]);
    }
  });

  it('a % or _ means itself', async () => {
    const tag = randomBytes(4).toString('hex');
    const t = await scratch({ legalName: `Percent 100% ${tag}` });
    await scratch({ legalName: `Percent 100x ${tag}` });
    const cookie = await as('READ_ONLY');
    const hit = await call('GET', `/tenants?q=${encodeURIComponent(`100% ${tag}`)}`, { cookie });
    expect((hit.body.data as { id: string }[]).map((r) => r.id)).toEqual([t.id]);
    expect(((await call('GET', `/tenants?q=${encodeURIComponent(`100_ ${tag}`)}`, { cookie })).body.data as unknown[]).length).toBe(0);
  });

  it('refuses an unknown parameter, a one-letter search and a bad cursor', async () => {
    const cookie = await as('READ_ONLY');
    expect((await call('GET', '/tenants?shard=1', { cookie })).status).toBe(400);
    expect((await call('GET', '/tenants?q=a', { cookie })).status).toBe(400);
    expect((await call('GET', '/tenants?cursor=nope', { cookie })).body.code).toBe('request.invalid_cursor');
  });
});

describe('[Q3, Q4] the detail', () => {
  it('shows the institution, and no secret anywhere', async () => {
    const t = await scratch();
    const r = await call('GET', `/tenants/${t.id}`, { cookie: await as('READ_ONLY') });
    expect(r.body).toMatchObject({ slug: t.slug, typeLocked: true, regulatory: { regulator: 'NUC', version: 0 }, branding: { primaryColor: null } });
    expect((r.body.products as { product: string; entitled: boolean }[]).find((p) => p.product === 'core')).toMatchObject({ alwaysOn: true, entitled: true });
    expect((r.body.products as { product: string; entitled: boolean }[]).find((p) => p.product === 'admissions')).toMatchObject({ entitled: true, enabled: true });
    expect(r.headers.etag).toBe('"v0"');
    expect(r.raw).not.toMatch(/secret|wrapped|verification_token|verificationToken/i);
  });

  it('an unknown institution is 404', async () => {
    expect((await call('GET', '/tenants/019a0000-0000-7000-8000-000000000001', { cookie: await as('READ_ONLY') })).status).toBe(404);
  });
});

describe('[Q5, Q6] the profile', () => {
  it('changes with the right version, audits only what changed, and a stale page gets 412', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    const changed = profile(t, { legalName: `${t.legalName} Renamed` });
    expect((await call('PUT', `/tenants/${t.id}`, { cookie, body: changed })).status).toBe(428);
    expect((await call('PUT', `/tenants/${t.id}`, { cookie, ifMatch: '"v0"', body: changed })).status).toBe(204);
    expect((await call('PUT', `/tenants/${t.id}`, { cookie, ifMatch: '"v0"', body: profile(t, { legalName: 'Too Late University' }) })).status).toBe(412);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: t.id }, select: { legalName: true, version: true } }))).toEqual({ legalName: changed.legalName, version: 1 });
    const [row] = await auditFor(t.id);
    expect(row).toMatchObject({ action: 'platform.tenant.profile_changed', metadata: { before: { legalName: t.legalName }, after: { legalName: changed.legalName } } });
    expect(Object.keys((row?.metadata as { after: object }).after)).toEqual(['legalName']);
  });

  it('nothing changed: no version, no audit', async () => {
    const t = await scratch();
    expect((await call('PUT', `/tenants/${t.id}`, { cookie: await as('OWNER'), ifMatch: '"v0"', body: profile(t) })).status).toBe(204);
    expect(await auditFor(t.id)).toEqual([]);
  });

  it('a stale version is refused even when nothing would change', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    await call('PUT', `/tenants/${t.id}`, { cookie, ifMatch: '"v0"', body: profile(t, { shortName: 'RENAMED' }) });
    expect((await call('PUT', `/tenants/${t.id}`, { cookie, ifMatch: '"v0"', body: profile(t, { shortName: 'RENAMED' }) })).status).toBe(412);
  });

  it('no route can change the slug: the field is refused', async () => {
    const t = await scratch();
    expect((await call('PUT', `/tenants/${t.id}`, { cookie: await as('OWNER'), ifMatch: '"v0"', body: profile(t, { slug: 'other' }) })).status).toBe(400);
  });

  it('the type changes before an institution is live, and not after', async () => {
    const cookie = await as('OWNER');
    const live = await scratch();
    expect((await call('PUT', `/tenants/${live.id}`, { cookie, ifMatch: '"v0"', body: profile(live, { type: 'POLYTECHNIC' }) })).body.code).toBe('tenant.type_locked');
    const early = await scratch({ status: 'ONBOARDING' });
    expect((await call('PUT', `/tenants/${early.id}`, { cookie, ifMatch: '"v0"', body: profile(early, { type: 'POLYTECHNIC' }) })).status).toBe(204);
    expect((await call('GET', `/tenants/${early.id}`, { cookie })).body).toMatchObject({ type: 'POLYTECHNIC', regulatory: { regulator: 'NBTE' } });
  });

  it('an archived institution takes no change of any kind', async () => {
    const t = await scratch({ status: 'ARCHIVED' });
    const cookie = await as('OWNER');
    expect((await call('PUT', `/tenants/${t.id}`, { cookie, ifMatch: '"v0"', body: profile(t, { legalName: 'Another Name' }) })).body.code).toBe('tenant.closed');
    expect((await call('PUT', `/tenants/${t.id}/branding/color`, { cookie, body: { primaryColor: '#1A3A6B' } })).body.code).toBe('tenant.closed');
    expect((await call('PUT', `/tenants/${t.id}/products/bursary`, { cookie, body: { entitled: true, reason: 'because I said' } })).body.code).toBe('tenant.closed');
  });
});

describe('[Q7] the regulatory profile', () => {
  const details = { operatingStatus: 'APPROVED', state: 'Lagos', regulatorReference: 'NUC/REF/1', jambCode: 'ABC123' };

  it('saves with a version, and a stale one gets 412', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie, ifMatch: '"v0"', body: details })).status).toBe(204);
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie, ifMatch: '"v0"', body: { ...details, state: 'Ogun' } })).status).toBe(412);
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie, ifMatch: '"v1"', body: { ...details, state: 'Ogun' } })).status).toBe(204);
    expect((await call('GET', `/tenants/${t.id}`, { cookie })).body).toMatchObject({ regulatory: { regulator: 'NUC', state: 'Ogun', version: 2 } });
    expect((await auditFor(t.id)).map((a) => a.action)).toEqual(['platform.tenant.regulatory_changed', 'platform.tenant.regulatory_changed']);
  });

  it('a version that doesn’t exist yet is stale, and creates nothing', async () => {
    const t = await scratch();
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie: await as('OWNER'), ifMatch: '"v5"', body: details })).status).toBe(412);
    expect(await db.tenantRegulatoryProfile.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('refuses a state that isn’t one, a regulator in the body, and a bad JAMB code', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie, ifMatch: '"v0"', body: { ...details, state: 'Atlantis' } })).status).toBe(400);
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie, ifMatch: '"v0"', body: { ...details, regulator: 'NBTE' } })).status).toBe(400);
    expect((await call('PUT', `/tenants/${t.id}/regulatory`, { cookie, ifMatch: '"v0"', body: { ...details, jambCode: 'AB-12' } })).status).toBe(400);
  });
});

describe('[Q9, Q10, Q16] branding', () => {
  it('a colour is saved with the text colour it carries; one nothing reads on is refused', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    expect((await call('PUT', `/tenants/${t.id}/branding/color`, { cookie, body: { primaryColor: '#1A3A6B' } })).status).toBe(204);
    expect((await call('GET', `/tenants/${t.id}`, { cookie })).body).toMatchObject({ branding: { primaryColor: '#1A3A6B', textColor: '#FFFFFF' } });
    expect((await call('PUT', `/tenants/${t.id}/branding/color`, { cookie, body: { primaryColor: '#888F8C' } })).body.code).toBe('tenant.color_contrast');
    expect((await call('PUT', `/tenants/${t.id}/branding/color`, { cookie, body: { primaryColor: 'red' } })).status).toBe(400);
  });

  it('a logo is stored, previewed as its checked type, and only its hash is audited', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    const base64 = png();
    expect((await call('PUT', `/tenants/${t.id}/branding/logo`, { cookie, body: { base64 } })).status).toBe(204);
    const shown = await call('GET', `/tenants/${t.id}/branding/logo`, { cookie });
    expect([shown.status, shown.headers['content-type'], shown.headers['x-content-type-options']]).toEqual([200, 'image/png', 'nosniff']);
    const detail = await call('GET', `/tenants/${t.id}`, { cookie });
    const hash = (detail.body.branding as { logoSha256: string }).logoSha256;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(await auditFor(t.id));
    expect(text).toContain(hash);
    expect(text).not.toContain(base64.slice(0, 40));
    expect((await call('DELETE', `/tenants/${t.id}/branding/logo`, { cookie })).status).toBe(204);
    expect((await call('GET', `/tenants/${t.id}/branding/logo`, { cookie })).status).toBe(404);
  });

  it('refuses an SVG, a renamed file, an oversized image and an oversized file', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    const put = (base64: string) => call('PUT', `/tenants/${t.id}/branding/logo`, { cookie, body: { base64 } });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect((await put(svg)).body.code).toBe('tenant.logo_refused');
    expect((await put(Buffer.from('MZ not an image at all, just some bytes pretending to be one').toString('base64'))).body.code).toBe('tenant.logo_refused');
    expect((await put(png(2000, 64))).body.code).toBe('tenant.logo_refused');
    expect((await put(png(64, 64, 256 * 1024 + 1))).body.code).toBe('tenant.logo_refused');
    expect((await call('GET', `/tenants/${t.id}`, { cookie })).body).toMatchObject({ branding: { logoSha256: null } });
  });
});

describe('[Q13, Q14] granting and revoking', () => {
  const invalidations = (tenantId: string) => migrator.cacheInvalidationEvent.count({ where: { tenantId, channel: 'uv:products:invalidate' } });

  it('grants with a reason, audited with it, and tells every instance', async () => {
    const t = await scratch();
    const cookie = await as('SUPER_ADMIN');
    const before = await invalidations(t.id);
    expect((await call('PUT', `/tenants/${t.id}/products/bursary`, { cookie, body: { entitled: true, reason: 'Signed the contract' } })).status).toBe(204);
    expect(await db.tenantProduct.findUniqueOrThrow({ where: { tenantId_product: { tenantId: t.id, product: 'bursary' } }, select: { entitled: true, enabled: true } })).toEqual({ entitled: true, enabled: false });
    expect(await invalidations(t.id)).toBeGreaterThan(before);
    expect((await auditFor(t.id)).at(-1)).toMatchObject({ action: 'platform.tenant.product_granted', metadata: { product: 'bursary', reason: 'Signed the contract' } });
  });

  it('revoking needs the slug typed, switches the product off, and can be undone', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    const url = `/tenants/${t.id}/products/admissions`;
    expect((await call('PUT', url, { cookie, body: { entitled: false, reason: 'Contract ended' } })).body.code).toBe('tenant.confirm_mismatch');
    expect((await call('PUT', url, { cookie, body: { entitled: false, reason: 'Contract ended', confirmSlug: 'wrong' } })).body.code).toBe('tenant.confirm_mismatch');
    expect((await call('PUT', url, { cookie, body: { entitled: false, reason: 'Contract ended', confirmSlug: t.slug } })).status).toBe(204);
    expect(await db.tenantProduct.findUniqueOrThrow({ where: { tenantId_product: { tenantId: t.id, product: 'admissions' } }, select: { entitled: true, enabled: true } })).toEqual({ entitled: false, enabled: false });
    expect((await call('PUT', url, { cookie, body: { entitled: true, reason: 'Renewed after all' } })).status).toBe(204);
    expect((await auditFor(t.id)).map((a) => a.action)).toEqual(['platform.tenant.product_revoked', 'platform.tenant.product_granted']);
  });

  it('refuses core, an unknown product, and a missing reason; a no-op records nothing', async () => {
    const t = await scratch();
    const cookie = await as('OWNER');
    expect((await call('PUT', `/tenants/${t.id}/products/core`, { cookie, body: { entitled: false, reason: 'Trying it', confirmSlug: t.slug } })).body.code).toBe('tenant.product_always_on');
    expect((await call('PUT', `/tenants/${t.id}/products/nothing`, { cookie, body: { entitled: true, reason: 'Trying it' } })).status).toBe(404);
    expect((await call('PUT', `/tenants/${t.id}/products/bursary`, { cookie, body: { entitled: true } })).status).toBe(400);
    expect((await call('PUT', `/tenants/${t.id}/products/admissions`, { cookie, body: { entitled: true, reason: 'Already has it' } })).status).toBe(204);
    expect(await auditFor(t.id)).toEqual([]);
  });

  it('one institution’s id never reaches another’s rows', async () => {
    const [a, b] = [await scratch(), await scratch()];
    const cookie = await as('OWNER');
    await call('PUT', `/tenants/${a.id}/branding/color`, { cookie, body: { primaryColor: '#1A3A6B' } });
    expect((await call('GET', `/tenants/${b.id}`, { cookie })).body).toMatchObject({ branding: { primaryColor: null } });
    expect(await auditFor(b.id)).toEqual([]);
  });
});
