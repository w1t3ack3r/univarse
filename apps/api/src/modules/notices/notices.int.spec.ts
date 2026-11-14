/**
 * Spec 0037 Q9, Q10, Q12 (T34): notices end to end, against the real databases. The console drafts, publishes and
 * withdraws through the platform API's own HTTP stack as the console role; the tenant API shows each institution its
 * own banners only, maintenance to everyone and the rest to IT Admins, as text; a dismissal is per person; a withdrawn
 * notice leaves at once; a published one never changes. The databases are shared with development, so every
 * institution here is its own (slug `ntc-…`), and no notice here is addressed to every institution.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, createTenantShardClient, forTenant, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { PlatformCredentials } from '../../platform/identity/credentials.js';
import { createPlatformApp } from '../../platform/platform-app.js';
import { CONSOLE_DB } from '../../platform/platform-config.js';
import { TenantResolver } from '../../shared/tenancy/tenant-resolver.service.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { hashPassword } from '../identity/password.js';
import { base32Decode, hotp, timeStep } from '../identity/totp.js';
import { NoticeBoard } from './notice-board.service.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'ntc-s6-';
const PASSWORD = 'Correct-Horse-Battery-9';
const CONSOLE = 'console.univarse.localhost';
const H = 3_600_000;
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';

let consoleApp: NestFastifyApplication;
let tenantApp: NestFastifyApplication;
let consoleDb: PlatformClient;
let migrator: PlatformClient;
let shard: TenantShardClient;
let creds: PlatformCredentials;
let poolId: string;
const staff = new Set<string>();
const cookies = new Map<Role, string>();
const published = new Set<string>();

const ip = () => `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

interface Res {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
  setCookie: string[];
}

async function inject(app: NestFastifyApplication, host: string, method: 'GET' | 'POST' | 'PUT', url: string, opts: { cookie?: string; body?: unknown; ifMatch?: string } = {}): Promise<Res> {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      remoteAddress: ip(),
      headers: {
        host,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.ifMatch ? { 'if-match': opts.ifMatch } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, headers: res.headers, setCookie: Array.isArray(raw) ? raw : raw ? [raw] : [] };
}

const cons = (method: 'GET' | 'POST' | 'PUT', url: string, opts: { cookie?: string; body?: unknown; ifMatch?: string } = {}) => inject(consoleApp, CONSOLE, method, `/api/platform/v1${url}`, opts);
const pick = (r: Res, name: string) => `${name}=${(r.setCookie.find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? ''}`;

async function as(role: Role, steppedUp = true): Promise<string> {
  const known = steppedUp ? cookies.get(role) : undefined;
  if (known) return known;
  const email = `${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  const { id } = await consoleDb.platformUser.create({ data: { email, displayName: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  staff.add(id);
  let secret = '';
  await consoleDb.$transaction(async (tx) => {
    secret = (await creds.beginFactor(tx, { id, email })).secret;
    expect(await creds.confirmFactor(tx, id, totp(secret, -1))).toBe(true);
  });
  const login = await cons('POST', '/auth/login', { body: { email, password: PASSWORD } });
  const mfa = await cons('POST', '/auth/mfa', { cookie: pick(login, '__Host-uv_console_mfa'), body: { code: totp(secret, 0) } });
  expect(mfa.status).toBe(200);
  let sid = pick(mfa, '__Host-uv_console_sid');
  if (steppedUp) {
    const up = await cons('POST', '/me/step-up', { cookie: sid, body: { code: totp(secret, 1) } });
    expect(up.status).toBe(204);
    sid = pick(up, '__Host-uv_console_sid');
    cookies.set(role, sid);
  }
  return sid;
}

interface Inst {
  id: string;
  host: string;
  admin: string;
  student: string;
}

/** An institution of its own, with an IT Admin (the INSTITUTION_ADMIN role) and a student, both able to sign in. */
async function institution(status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' = 'ACTIVE'): Promise<Inst> {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const host = `${slug}.univarse.localhost`;
  const t = await migrator.tenant.create({ data: { slug, legalName: `Notice Test ${slug}`, shortName: slug.slice(-8).toUpperCase(), type: 'UNIVERSITY', ownership: 'STATE', status, shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  const db = forTenant(shard, t.id);
  const user = async (key: string, permissions: string[]) => {
    const role = await db.role.create({ data: { tenantId: t.id, key, name: key, isSystem: true, permissions }, select: { id: true } });
    const username = `N6-${randomBytes(3).toString('hex').toUpperCase()}`;
    const u = await db.userAccount.create({ data: { tenantId: t.id, username, displayName: 'Test Person', status: 'ACTIVE', passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
    await db.roleAssignment.create({ data: { tenantId: t.id, userId: u.id, roleId: role.id, scopeType: 'INSTITUTION' } });
    return username;
  };
  // A permission no MFA rule covers, so the role's holders sign in with a password here.
  const admin = await user('INSTITUTION_ADMIN', ['settings.tenant.view']);
  const student = await user('STUDENT', []);
  return { id: t.id, host, admin, student };
}

const signIn = async (i: Inst, username: string) => {
  const r = await inject(tenantApp, i.host, 'POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
  expect(r.status).toBe(200);
  return (r.setCookie[0] ?? '').split(';')[0] ?? '';
};
const fresh = () => {
  tenantApp.get(TenantResolver).invalidate();
  tenantApp.get(NoticeBoard).invalidate();
};
const banners = async (i: Inst, cookie?: string) => {
  const r = await inject(tenantApp, i.host, 'GET', cookie ? '/api/v1/notices' : '/api/v1/tenant/notices', cookie ? { cookie } : {});
  expect(r.status).toBe(200);
  return (r.body.data as { id: string; title: string; body: string; kind: string }[]);
};
const ids = (list: { id: string }[]) => list.map((n) => n.id);

const soon = () => ({ startsAt: new Date(Date.now() + H).toISOString(), endsAt: new Date(Date.now() + 3 * H).toISOString() });
const draft = (over: Record<string, unknown> = {}) => ({ kind: 'ANNOUNCEMENT', title: 'New results screens', body: 'From Monday, results open in the new screens.', audience: 'TENANTS', ...over });

async function publishNew(cookie: string, body: Record<string, unknown>): Promise<{ id: string; version: number }> {
  const made = await cons('POST', '/notices', { cookie, body });
  expect(made.status).toBe(201);
  const id = made.body.id as string;
  const pub = await cons('POST', `/notices/${id}/publish`, { cookie, ifMatch: made.headers.etag as string });
  expect([pub.status, pub.body.code]).toEqual([200, undefined]);
  published.add(id);
  return { id, version: pub.body.version as number };
}

beforeAll(async () => {
  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }));
  consoleDb = consoleApp.get(CONSOLE_DB);
  creds = consoleApp.get(PlatformCredentials);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  tenantApp = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

afterAll(async () => {
  const owner = cookies.get('OWNER');
  if (owner) for (const id of published) await cons('POST', `/notices/${id}/withdraw`, { cookie: owner });
  await consoleDb.platformSession.updateMany({ where: { userId: { in: [...staff] }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await consoleDb.platformUser.updateMany({ where: { id: { in: [...staff] } }, data: { role: 'READ_ONLY', isActive: false } });
  await shard.$disconnect();
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await tenantApp.close();
  await consoleApp.close();
});

describe('[Q1] who may write notices and set rings', () => {
  it('SUPPORT publishes; FINANCE and READ_ONLY only read; only OWNER and SUPER_ADMIN set a ring', async () => {
    const i = await institution();
    const support = await as('SUPPORT');
    const n = await publishNew(support, draft({ tenantIds: [i.id] }));
    for (const role of ['FINANCE', 'READ_ONLY'] as const) {
      const cookie = await as(role);
      expect([role, (await cons('GET', `/notices/${n.id}`, { cookie })).status]).toEqual([role, 200]);
      expect([role, (await cons('POST', '/notices', { cookie, body: draft({ tenantIds: [i.id] }) })).status]).toEqual([role, 404]);
      expect([role, (await cons('POST', `/notices/${n.id}/withdraw`, { cookie })).status]).toEqual([role, 404]);
      expect([role, (await cons('PUT', `/tenants/${i.id}/ring`, { cookie, body: { ring: 'PILOT' } })).status]).toEqual([role, 404]);
    }
    expect((await cons('PUT', `/tenants/${i.id}/ring`, { cookie: support, body: { ring: 'PILOT' } })).status).toBe(404);
    expect((await cons('POST', '/notices', { cookie: await as('SUPER_ADMIN', false), body: draft({ tenantIds: [i.id] }) })).body.code).toBe('auth.step_up_required');
  });
});

describe('[Q9, Q10, T34] a notice reaches exactly its audience, as text', () => {
  it('shows an announcement to the chosen institution’s IT Admins only, and nowhere else', async () => {
    const [a, b] = [await institution(), await institution()];
    const markup = '<script>alert(1)</script><img src=x onerror=alert(1)> See https://example.test/notes';
    const n = await publishNew(await as('OWNER'), draft({ title: 'Release <b>notes</b>', body: markup, kind: 'RELEASE_NOTE', tenantIds: [a.id] }));
    fresh();
    const [aAdmin, aStudent, bAdmin] = [await signIn(a, a.admin), await signIn(a, a.student), await signIn(b, b.admin)];
    const seen = await banners(a, aAdmin);
    expect(ids(seen)).toContain(n.id);
    // Stored and returned exactly as written: the web app renders it as text (the e2e checks the page).
    expect(seen.find((s) => s.id === n.id)).toMatchObject({ title: 'Release <b>notes</b>', body: markup });
    expect(ids(await banners(a, aStudent))).not.toContain(n.id);
    expect(ids(await banners(a))).not.toContain(n.id);
    expect(ids(await banners(b, bAdmin))).not.toContain(n.id);
  });

  it('shows maintenance to everyone there, signed in or not, and on no other institution', async () => {
    const [a, b] = [await institution(), await institution()];
    const n = await publishNew(await as('OWNER'), draft({ kind: 'MAINTENANCE', title: 'Planned maintenance', tenantIds: [a.id], ...soon() }));
    fresh();
    expect(ids(await banners(a))).toContain(n.id);
    expect(ids(await banners(a, await signIn(a, a.student)))).toContain(n.id);
    expect(ids(await banners(b))).not.toContain(n.id);
  });

  it('reaches a ring as it is when published: suspended institutions included, archived ones not', async () => {
    const owner = await as('OWNER');
    const [live, suspended, archived, general] = [await institution(), await institution('SUSPENDED'), await institution('ARCHIVED'), await institution()];
    for (const t of [live, suspended]) expect((await cons('PUT', `/tenants/${t.id}/ring`, { cookie: owner, body: { ring: 'PILOT' } })).status).toBe(204);
    // An archived institution takes no change, a ring included; this one was in the pilot before it was archived.
    expect((await cons('PUT', `/tenants/${archived.id}/ring`, { cookie: owner, body: { ring: 'PILOT' } })).status).toBe(409);
    await migrator.tenant.update({ where: { id: archived.id }, data: { releaseRing: 'PILOT' } });
    const n = await publishNew(owner, draft({ audience: 'RING', ring: 'PILOT', kind: 'RELEASE_NOTE' }));
    const reached = (await cons('GET', `/notices/${n.id}`, { cookie: owner })).body.deliveries as { tenant: { id: string } }[];
    const got = new Set(reached.map((d) => d.tenant.id));
    expect([got.has(live.id), got.has(suspended.id), got.has(archived.id), got.has(general.id)]).toEqual([true, true, false, false]);
    // A ring set later doesn't move a published notice.
    expect((await cons('PUT', `/tenants/${general.id}/ring`, { cookie: owner, body: { ring: 'PILOT' } })).status).toBe(204);
    const again = (await cons('GET', `/notices/${n.id}`, { cookie: owner })).body.deliveries as unknown[];
    expect(again).toHaveLength(reached.length);
    const ringAudit = await migrator.platformAuditEvent.findFirstOrThrow({ where: { tenantId: general.id, action: 'platform.tenant.ring_changed' }, select: { metadata: true } });
    expect(ringAudit.metadata).toMatchObject({ before: 'GENERAL', after: 'PILOT' });
  });

  it('a person dismisses a banner for themselves only; one not shown to them is 404', async () => {
    const a = await institution();
    const owner = await as('OWNER');
    const m = await publishNew(owner, draft({ kind: 'MAINTENANCE', title: 'Planned maintenance', tenantIds: [a.id], ...soon() }));
    const note = await publishNew(owner, draft({ tenantIds: [a.id] }));
    fresh();
    const [admin, student] = [await signIn(a, a.admin), await signIn(a, a.student)];
    expect((await inject(tenantApp, a.host, 'POST', `/api/v1/notices/${m.id}/dismiss`, { cookie: student })).status).toBe(204);
    expect((await inject(tenantApp, a.host, 'POST', `/api/v1/notices/${m.id}/dismiss`, { cookie: student })).status).toBe(204);
    expect(ids(await banners(a, student))).not.toContain(m.id);
    expect(ids(await banners(a, admin))).toContain(m.id);
    expect((await inject(tenantApp, a.host, 'POST', `/api/v1/notices/${note.id}/dismiss`, { cookie: student })).status).toBe(404);
    expect((await inject(tenantApp, a.host, 'POST', '/api/v1/notices/not-a-uuid/dismiss', { cookie: student })).status).toBe(404);
    expect((await inject(tenantApp, a.host, 'POST', `/api/v1/notices/${m.id}/dismiss`)).status).toBe(401);
  });
});

describe('[Q9] a published notice never changes, and a withdrawn one leaves at once', () => {
  it('refuses edits and a second publish after publishing; withdrawal empties every banner', async () => {
    const a = await institution();
    const owner = await as('OWNER');
    const n = await publishNew(owner, draft({ tenantIds: [a.id] }));
    const edit = await cons('PUT', `/notices/${n.id}`, { cookie: owner, ifMatch: `"v${String(n.version)}"`, body: draft({ title: 'Changed', tenantIds: [a.id] }) });
    expect([edit.status, edit.body.code]).toEqual([409, 'notice.not_draft']);
    expect((await cons('POST', `/notices/${n.id}/publish`, { cookie: owner, ifMatch: `"v${String(n.version)}"` })).body.code).toBe('notice.not_draft');
    fresh();
    const admin = await signIn(a, a.admin);
    expect(ids(await banners(a, admin))).toContain(n.id);
    expect((await cons('POST', `/notices/${n.id}/withdraw`, { cookie: owner })).status).toBe(200);
    // This instance's own cache: the relay isn't running here; on the stack its message evicts every instance.
    tenantApp.get(NoticeBoard).invalidate();
    expect(ids(await banners(a, admin))).not.toContain(n.id);
    expect((await cons('POST', `/notices/${n.id}/withdraw`, { cookie: owner })).body.code).toBe('notice.already_withdrawn');
    const deliveries = await migrator.platformNoticeDelivery.findMany({ where: { noticeId: n.id }, select: { withdrawnAt: true } });
    expect(deliveries.every((d) => d.withdrawnAt !== null)).toBe(true);
    // The capture told the institution's caches.
    const events = await migrator.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM cache_invalidation_event WHERE tenant_id = ${a.id}::uuid AND source LIKE 'platform_notice_delivery:%'`;
    expect(Number(events[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('publishing checks the draft again, with If-Match, and an audience of no one is refused', async () => {
    const owner = await as('OWNER');
    const bad = await cons('POST', '/notices', { cookie: owner, body: draft({ kind: 'MAINTENANCE', tenantIds: [] }) });
    expect(bad.status).toBe(201);
    expect((bad.body.problems as { code: string }[]).map((p) => p.code).sort()).toEqual(['tenants_required', 'window_required']);
    const refused = await cons('POST', `/notices/${bad.body.id as string}/publish`, { cookie: owner, ifMatch: bad.headers.etag as string });
    expect([refused.status, refused.body.code]).toEqual([422, 'notice.not_ready']);
    expect((await cons('POST', `/notices/${bad.body.id as string}/publish`, { cookie: owner })).status).toBe(428);
    expect((await cons('POST', `/notices/${bad.body.id as string}/publish`, { cookie: owner, ifMatch: '"v99"' })).status).toBe(412);
    const archived = await institution('ARCHIVED');
    const nobody = await cons('POST', '/notices', { cookie: owner, body: draft({ tenantIds: [archived.id] }) });
    expect((await cons('POST', `/notices/${nobody.body.id as string}/publish`, { cookie: owner, ifMatch: nobody.headers.etag as string })).body.code).toBe('notice.no_audience');
    const discarded = await cons('POST', `/notices/${nobody.body.id as string}/withdraw`, { cookie: owner });
    expect(discarded.body).toMatchObject({ status: 'WITHDRAWN', publishedAt: null });
  });

  it('the database refuses changing a published notice or re-pointing its audience, for every role', async () => {
    const a = await institution();
    const n = await publishNew(await as('OWNER'), draft({ tenantIds: [a.id] }));
    await expect(migrator.platformNotice.update({ where: { id: n.id }, data: { body: 'rewritten' } })).rejects.toThrow(/can.t change/);
    await expect(migrator.platformNotice.update({ where: { id: n.id }, data: { status: 'DRAFT' } })).rejects.toThrow(/forward once/);
    const other = await institution();
    await expect(migrator.platformNoticeDelivery.update({ where: { noticeId_tenantId: { noticeId: n.id, tenantId: a.id } }, data: { tenantId: other.id } })).rejects.toThrow(/audience/);
    await expect(migrator.$executeRaw`UPDATE platform_notice SET title = repeat('x', 121) WHERE id = ${n.id}::uuid`).rejects.toThrow();
  });
});

describe('[Q11, Q12] the institution’s detail', () => {
  it('shows its ring and the notices it got', async () => {
    const a = await institution();
    const owner = await as('OWNER');
    const n = await publishNew(owner, draft({ tenantIds: [a.id], title: 'For the detail page' }));
    const detail = await cons('GET', `/tenants/${a.id}`, { cookie: owner });
    expect(detail.body.releaseRing).toBe('GENERAL');
    expect(detail.body.notices).toEqual([expect.objectContaining({ id: n.id, title: 'For the detail page', live: true, withdrawnAt: null })]);
  });
});
