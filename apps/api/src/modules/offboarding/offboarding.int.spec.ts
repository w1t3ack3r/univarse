/**
 * Spec 0038 Q2–Q6, Q15: offboarding end to end, against the real databases. The console starts, cancels and extends
 * through the platform API's own HTTP stack as the console role; the worker's pass warns the IT Admins through the
 * institution's outbox (once each, never a backlog), archives after the last day and ends every session; the tenant API
 * keeps serving during the window and answers 410 after it. The pass takes "now", so no clock is moved. Institutions here
 * are their own (slug `susp-off-…`), removed at the end.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { keyProviderFrom, provisionTenantKey } from '@univarse/crypto';
import { createPlatformClient, createTenantShardClient, forTenant, type PlatformClient, type TenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { PlatformCredentials } from '../../platform/identity/credentials.js';
import type { PlatformActor } from '../../platform/identity/types.js';
import { PlatformInboxView } from '../../platform/inbox/inbox.service.js';
import { createPlatformApp } from '../../platform/platform-app.js';
import { CONSOLE_DB } from '../../platform/platform-config.js';
import { TenantResolver } from '../../shared/tenancy/tenant-resolver.service.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { WorkerModule } from '../../worker.module.js';
import { hashPassword } from '../identity/password.js';
import { base32Decode, hotp, timeStep } from '../identity/totp.js';
import { TenantOffboarding } from '../../platform/registry/offboarding.service.js';
import { main as testClock } from '../../cli/test-clock.js';
import { OffboardingArchive } from './offboarding-archive.js';
import { OffboardingPass } from './offboarding-pass.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'susp-off-';
const PASSWORD = 'Correct-Horse-Battery-9';
const CONSOLE = 'console.univarse.localhost';
const DAY = 86_400_000;
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT';

let consoleApp: NestFastifyApplication;
let tenantApp: NestFastifyApplication;
let worker: INestApplicationContext;
let pass: OffboardingPass;
let clock: OffboardingArchive;
let consoleDb: PlatformClient;
let migrator: PlatformClient;
let shard: TenantShardClient;
let creds: PlatformCredentials;
let poolId: string;
const staff = new Map<string, Role>();
const cookies = new Map<Role, string>();

const ip = () => `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

interface Res {
  status: number;
  body: Record<string, unknown>;
  setCookie: string[];
}

async function inject(app: NestFastifyApplication, host: string, method: 'GET' | 'POST', url: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
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
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  const raw = res.headers['set-cookie'];
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, setCookie: Array.isArray(raw) ? raw : raw ? [raw] : [] };
}

const cons = (method: 'GET' | 'POST', url: string, opts: { cookie?: string; body?: unknown } = {}) => inject(consoleApp, CONSOLE, method, `/api/platform/v1${url}`, opts);
const pick = (r: Res, name: string) => `${name}=${(r.setCookie.find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0]?.split('=').slice(1).join('=') ?? ''}`;

async function as(role: Role, steppedUp = true): Promise<string> {
  const known = steppedUp ? cookies.get(role) : undefined;
  if (known) return known;
  const email = `${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  const { id } = await consoleDb.platformUser.create({ data: { email, displayName: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  staff.set(id, role);
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

/** An institution with a data key, an IT Admin with an address, and a student who signs in with a password. */
async function institution(status: 'ACTIVE' | 'ONBOARDING' | 'REQUESTED' | 'SUSPENDED' = 'ACTIVE') {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const host = `${slug}.univarse.localhost`;
  const t = await migrator.tenant.create({ data: { slug, legalName: `Leaving Polytechnic ${slug}`, shortName: 'LP', type: 'POLYTECHNIC', ownership: 'STATE', status, shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await provisionTenantKey(migrator, keyProviderFrom(loadConfig({ ...process.env, NODE_ENV: 'test' })), t.id);
  const db = forTenant(shard, t.id);
  const role = async (key: string, permissions: string[]) => (await db.role.create({ data: { tenantId: t.id, key, name: key, isSystem: true, permissions }, select: { id: true } })).id;
  const person = async (roleId: string, email: string | null) => {
    const username = `OF-${randomBytes(3).toString('hex').toUpperCase()}`;
    const u = await db.userAccount.create({ data: { tenantId: t.id, username, displayName: 'Test Person', status: 'ACTIVE', email, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
    await db.roleAssignment.create({ data: { tenantId: t.id, userId: u.id, roleId, scopeType: 'INSTITUTION' } });
    return username;
  };
  await person(await role('INSTITUTION_ADMIN', ['settings.product.manage']), `it-${slug}@test.local`);
  const student = await person(await role('STUDENT', []), `student-${slug}@test.local`);
  return { id: t.id, slug, host, student };
}

const offboarding = (tenantId: string) => migrator.platformTenantOffboarding.findFirstOrThrow({ where: { tenantId }, orderBy: { startedAt: 'desc' } });
const statusOf = async (id: string) => (await migrator.tenant.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const warningEmails = async (tenantId: string) => {
  const ids = (await migrator.platformOffboardingWarning.findMany({ where: { offboarding: { tenantId } }, select: { id: true } })).map((w) => w.id);
  return forTenant(shard, tenantId).outboxEvent.count({ where: { noticeId: { in: ids } } });
};
const start = (cookie: string, id: string, body: unknown = { reason: 'CONTRACT_ENDED' }) => cons('POST', `/tenants/${id}/offboarding`, { cookie, body });
const fresh = () => tenantApp.get(TenantResolver).invalidate();

beforeAll(async () => {
  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }));
  consoleDb = consoleApp.get(CONSOLE_DB);
  creds = consoleApp.get(PlatformCredentials);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  tenantApp = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', OFFBOARDING_INTERVAL_MS: '0', NOTICE_RELAY_INTERVAL_MS: '0', NOTICE_COUNT_INTERVAL_MS: '0' }, 'worker'), { mailer: { send: () => Promise.resolve() }, subscribe: false }),
    { logger: false },
  );
  pass = worker.get(OffboardingPass);
  clock = worker.get(OffboardingArchive);
});

afterAll(async () => {
  const ids = [...staff.keys()];
  await consoleDb.platformSession.updateMany({ where: { userId: { in: ids }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await consoleDb.platformUser.updateMany({ where: { id: { in: ids } }, data: { role: 'READ_ONLY', isActive: false } });
  await shard.$disconnect();
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await worker.close();
  await tenantApp.close();
  await consoleApp.close();
});

describe('[Q1, Q2] starting and cancelling', () => {
  it('only OWNER and SUPER_ADMIN, stepped up; from active or onboarding; a note for "other"', async () => {
    const t = await institution();
    expect((await start(await as('SUPPORT'), t.id)).status).toBe(404);
    expect((await start(await as('SUPER_ADMIN', false), t.id)).body.code).toBe('auth.step_up_required');
    const owner = await as('OWNER');
    expect((await start(owner, t.id, { reason: 'OTHER' })).body.code).toBe('tenant.offboarding_note');
    expect((await start(owner, (await institution('REQUESTED')).id)).body.code).toBe('tenant.not_offboardable');
    expect((await start(owner, (await institution('SUSPENDED')).id)).body.code).toBe('tenant.not_offboardable');
    expect((await start(owner, t.id)).status).toBe(204);
    expect((await start(owner, t.id)).body.code).toBe('tenant.not_offboardable');
    const o = await offboarding(t.id);
    expect(o.endsAt.getTime() - o.startedAt.getTime()).toBeGreaterThan(60 * DAY - DAY);
    expect(o.endsAt.getTime() - o.startedAt.getTime()).toBeLessThanOrEqual(61 * DAY);
    expect(await statusOf(t.id)).toBe('OFFBOARDING');
  });

  it('keeps the institution working with its closing date, and a cancel returns it as it was', async () => {
    const t = await institution();
    const owner = await as('OWNER');
    await start(owner, t.id);
    fresh();
    const profile = await inject(tenantApp, t.host, 'GET', '/api/v1/tenant/public-profile');
    expect(profile.status).toBe(200);
    expect(profile.body.closesAt).toBe((await offboarding(t.id)).endsAt.toISOString());
    expect((await inject(tenantApp, t.host, 'POST', '/api/v1/auth/login', { body: { username: t.student, password: PASSWORD } })).status).toBe(200);
    expect((await cons('POST', `/tenants/${t.id}/offboarding/cancel`, { cookie: owner })).status).toBe(204);
    expect(await statusOf(t.id)).toBe('ACTIVE');
    fresh();
    expect((await inject(tenantApp, t.host, 'GET', '/api/v1/tenant/public-profile')).body.closesAt).toBeNull();
    expect((await cons('POST', `/tenants/${t.id}/offboarding/cancel`, { cookie: owner })).body.code).toBe('tenant.not_offboarding');
    // A new window can start after a cancelled one.
    expect((await start(owner, t.id)).status).toBe(204);
  });

  it('can’t be cancelled once its last day is over, even before the worker has archived it', async () => {
    const t = await institution();
    await start(await as('OWNER'), t.id);
    const o = await offboarding(t.id);
    const ownerId = [...staff.entries()].find(([, r]) => r === 'OWNER')![0];
    const actor: PlatformActor = { userId: ownerId, sessionId: 'x', email: 'x', displayName: 'x', role: 'OWNER', isActive: true, mfaAt: new Date(), restricted: false, stepUpAt: new Date() };
    await expect(consoleApp.get(TenantOffboarding).cancel(actor, t.id, { ip: '127.0.0.1', userAgent: undefined }, new Date(o.endsAt.getTime() + 1))).rejects.toMatchObject({ code: 'tenant.not_offboarding' });
    expect(await statusOf(t.id)).toBe('OFFBOARDING');
  });
});

describe('[Q4, Q5] the worker: warnings, the archive and the sessions', () => {
  it('warns the IT Admins once per day due, never a backlog, then archives and ends every session', async () => {
    const t = await institution();
    const owner = await as('OWNER');
    await start(owner, t.id);
    const o = await offboarding(t.id);
    const at = (left: number) => new Date(o.endsAt.getTime() - left * DAY + 1);

    await pass.pass(new Date());
    await pass.pass(new Date());
    let warnings = await migrator.platformOffboardingWarning.findMany({ where: { offboardingId: o.id }, orderBy: { createdAt: 'asc' } });
    expect(warnings.map((w) => [w.round, w.daysLeft, w.itAdmins, w.emailsQueued])).toEqual([[0, 60, 1, 1]]);
    expect(await warningEmails(t.id)).toBe(1);

    // The worker was down from day 45 to day 13: only the latest due goes out.
    await pass.pass(at(13));
    warnings = await migrator.platformOffboardingWarning.findMany({ where: { offboardingId: o.id }, orderBy: { createdAt: 'asc' } });
    expect(warnings.map((w) => w.daysLeft)).toEqual([60, 14]);
    await pass.pass(at(1));
    expect(await warningEmails(t.id)).toBe(3);

    // A student signs in before the end; after it, the archive ends the session and the address answers 410.
    fresh();
    const login = await inject(tenantApp, t.host, 'POST', '/api/v1/auth/login', { body: { username: t.student, password: PASSWORD } });
    const cookie = (login.setCookie[0] ?? '').split(';')[0] ?? '';
    await pass.pass(new Date(o.endsAt.getTime() + 1));
    expect(await statusOf(t.id)).toBe('ARCHIVED');
    const after = await offboarding(t.id);
    expect(after.archivedAt).not.toBeNull();
    expect(after.sessionsEndedAt).not.toBeNull();
    const sessions = await forTenant(shard, t.id).session.findMany({ select: { revokedAt: true, revokeReason: true } });
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(sessions.some((s) => s.revokeReason === 'tenant_archived')).toBe(true);
    fresh();
    const closed = await inject(tenantApp, t.host, 'GET', '/api/v1/auth/me', { cookie });
    expect(closed.status).toBe(410);
    expect(closed.body).toMatchObject({ code: 'tenant.archived', institution: { legalName: expect.stringContaining('Leaving Polytechnic') } });
    expect((await cons('POST', `/tenants/${t.id}/offboarding/cancel`, { cookie: owner })).body.code).toBe('tenant.not_offboarding');
    const actions = (await migrator.platformAuditEvent.findMany({ where: { tenantId: t.id, action: { startsWith: 'platform.tenant.' } }, orderBy: { seq: 'asc' }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual([
      'platform.tenant.offboarding_started',
      'platform.tenant.offboarding_warning_sent',
      'platform.tenant.offboarding_warning_sent',
      'platform.tenant.offboarding_warning_sent',
      'platform.tenant.archived',
      'platform.tenant.archive_sessions_ended',
    ]);
  });

  it('finishes a warning a stopped pass left, without emailing twice', async () => {
    const t = await institution();
    await start(await as('OWNER'), t.id);
    const o = await offboarding(t.id);
    await pass.pass(new Date());
    // As if the pass stopped after the emails, before recording them.
    await migrator.$executeRaw`ALTER TABLE platform_offboarding_warning DISABLE TRIGGER platform_offboarding_warning_guard_update`;
    try {
      await migrator.platformOffboardingWarning.updateMany({ where: { offboardingId: o.id }, data: { queuedAt: null, itAdmins: null, emailsQueued: null } });
    } finally {
      await migrator.$executeRaw`ALTER TABLE platform_offboarding_warning ENABLE TRIGGER platform_offboarding_warning_guard_update`;
    }
    await pass.pass(new Date());
    expect(await warningEmails(t.id)).toBe(1);
    expect((await migrator.platformOffboardingWarning.findFirstOrThrow({ where: { offboardingId: o.id } })).queuedAt).not.toBeNull();
  });

  it('a suspension during the window returns to it (Q3), and its warnings still go out', async () => {
    const t = await institution();
    const owner = await as('OWNER');
    await start(owner, t.id);
    expect((await cons('POST', `/tenants/${t.id}/suspend`, { cookie: owner, body: { reason: 'SECURITY_INCIDENT' } })).status).toBe(204);
    await pass.pass(new Date());
    expect(await warningEmails(t.id)).toBe(1);
    const susp = await migrator.platformTenantSuspension.findFirstOrThrow({ where: { tenantId: t.id } });
    expect(susp.previousStatus).toBe('OFFBOARDING');
    await migrator.platformTenantSuspension.update({ where: { id: susp.id }, data: { sessionsEndedAt: new Date(), sessionsEnded: 0 } });
    expect((await cons('POST', `/tenants/${t.id}/resume`, { cookie: owner })).status).toBe(204);
    expect(await statusOf(t.id)).toBe('OFFBOARDING');
  });
});

describe('[Q6] the extension', () => {
  it('gives an archived institution 14 more days, once, with its own warnings', async () => {
    const t = await institution();
    const owner = await as('OWNER');
    await start(owner, t.id);
    const o = await offboarding(t.id);
    await pass.pass(new Date(o.endsAt.getTime() + 1));
    expect(await statusOf(t.id)).toBe('ARCHIVED');
    expect((await cons('POST', `/tenants/${t.id}/offboarding/extend`, { cookie: owner, body: { reason: 'x' } })).status).toBe(400);
    expect((await cons('POST', `/tenants/${t.id}/offboarding/extend`, { cookie: owner, body: { reason: 'They missed their export' } })).status).toBe(204);
    expect(await statusOf(t.id)).toBe('OFFBOARDING');
    const extended = await offboarding(t.id);
    expect(extended.extendedAt).not.toBeNull();
    // 14 days from the extension, to the end of that day in Nigerian time.
    expect(extended.endsAt.getTime() - Date.now()).toBeGreaterThan(14 * DAY - DAY);
    expect(extended.endsAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * DAY);
    await pass.pass(new Date());
    expect((await migrator.platformOffboardingWarning.findMany({ where: { offboardingId: o.id, round: 1 } })).map((w) => w.daysLeft)).toEqual([14]);
    await pass.pass(new Date(extended.endsAt.getTime() + 1));
    expect(await statusOf(t.id)).toBe('ARCHIVED');
    expect((await cons('POST', `/tenants/${t.id}/offboarding/extend`, { cookie: owner, body: { reason: 'Again, please' } })).body.code).toBe('tenant.not_extendable');
  });
});

describe('[Q2, Q15] the database, and the inbox', () => {
  it('holds the record, one open window per institution, and the warnings to the worker', async () => {
    const t = await institution();
    await start(await as('OWNER'), t.id);
    const o = await offboarding(t.id);
    await expect(migrator.platformTenantOffboarding.update({ where: { id: o.id }, data: { reason: 'OTHER', note: 'rewritten' } })).rejects.toThrow(/can.t change/);
    await expect(
      migrator.$executeRaw`INSERT INTO platform_tenant_offboarding (tenant_id, reason, previous_status, started_by, first_ends_at, ends_at, updated_at)
        VALUES (${t.id}::uuid, 'CONTRACT_ENDED', 'ACTIVE', ${o.startedBy}::uuid, now() + interval '1 day', now() + interval '1 day', now())`,
    ).rejects.toThrow(/open_key/);
    const [row] = await consoleDb.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_table_privilege(current_user, 'platform_offboarding_warning', 'INSERT') AS ok`);
    expect(row?.ok).toBe(false);
  });

  it('lists a window ending within a week to those who can act on it', async () => {
    const t = await institution();
    await start(await as('OWNER'), t.id);
    const o = await offboarding(t.id);
    const inbox = consoleApp.get(PlatformInboxView);
    const actor = (role: Role): PlatformActor => ({ userId: [...staff.entries()].find(([, r]) => r === role)?.[0] ?? '', sessionId: 'x', email: 'x', displayName: 'x', role, isActive: true, mfaAt: new Date(), restricted: false, stepUpAt: new Date() });
    const soon = new Date(o.endsAt.getTime() - 3 * DAY);
    expect((await inbox.read(actor('OWNER'), soon)).items.some((i) => i.type === 'offboarding_ending' && i.tenant.id === t.id)).toBe(true);
    expect((await inbox.read(actor('SUPPORT'), soon)).items.some((i) => i.type === 'offboarding_ending')).toBe(false);
    expect((await inbox.read(actor('OWNER'), new Date())).items.some((i) => i.type === 'offboarding_ending' && i.tenant.id === t.id)).toBe(false);
  });
});

describe("[Q-D1–Q-D4] the stack's test clock", () => {
  const login = async (t: { host: string; student: string }) => {
    fresh();
    expect((await inject(tenantApp, t.host, 'POST', '/api/v1/auth/login', { body: { username: t.student, password: PASSWORD } })).status).toBe(200);
  };
  const live = (tenantId: string) => forTenant(shard, tenantId).session.count({ where: { revokedAt: null } });
  const archived = (tenantId: string) =>
    migrator.platformAuditEvent.findMany({ where: { tenantId, action: 'platform.tenant.archived' }, select: { actorId: true, metadata: true } });

  it('archives an institution leaving that never went live, now, and nothing else', async () => {
    const owner = await as('OWNER');
    const a = await institution('ONBOARDING');
    const b = await institution('ONBOARDING');
    await start(owner, a.id);
    await start(owner, b.id);
    await pass.pass(new Date());
    await login(a);
    await login(b);
    const warningsBefore = await migrator.platformOffboardingWarning.count({ where: { offboarding: { tenantId: { in: [a.id, b.id] } } } });

    const before = Date.now();
    const r = await clock.byTestClock(a.slug);
    expect(r).toMatchObject({ ok: true, tenantId: a.id, archived: 'now', sessionsEnded: true });
    expect(r.ok && r.daysLeft).toBeGreaterThanOrEqual(60);
    expect(await statusOf(a.id)).toBe('ARCHIVED');
    const o = await offboarding(a.id);
    // The real time, never a fake date; the window's end is left as it was.
    expect(o.archivedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(o.archivedAt!.getTime()).toBeLessThan(o.endsAt.getTime());
    expect(o.sessionsEndedAt).not.toBeNull();
    expect(await live(a.id)).toBe(0);
    const audit = await archived(a.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBeNull();
    expect(audit[0]?.metadata).toMatchObject({ testClock: true, daysLeft: r.ok ? r.daysLeft : -1 });
    // No warning sent, and the other institution untouched.
    expect(await migrator.platformOffboardingWarning.count({ where: { offboarding: { tenantId: { in: [a.id, b.id] } } } })).toBe(warningsBefore);
    expect(await statusOf(b.id)).toBe('OFFBOARDING');
    expect((await offboarding(b.id)).archivedAt).toBeNull();
    expect(await live(b.id)).toBe(1);
    expect(await archived(b.id)).toHaveLength(0);

    // Again: already archived, nothing new.
    expect(await clock.byTestClock(a.slug)).toMatchObject({ ok: true, archived: 'already', sessionsEnded: false });
    expect(await archived(a.id)).toHaveLength(1);
  });

  it('refuses one that went live, one not leaving, one suspended, one cancelled, and an unknown slug', async () => {
    const owner = await as('OWNER');
    const wentLive = await institution('ACTIVE');
    await start(owner, wentLive.id);
    expect(await clock.byTestClock(wentLive.slug)).toEqual({ ok: false, refused: 'went_live' });
    expect(await statusOf(wentLive.id)).toBe('OFFBOARDING');

    const staying = await institution('ONBOARDING');
    expect(await clock.byTestClock(staying.slug)).toEqual({ ok: false, refused: 'not_offboarding' });

    const suspended = await institution('ONBOARDING');
    await start(owner, suspended.id);
    expect((await cons('POST', `/tenants/${suspended.id}/suspend`, { cookie: owner, body: { reason: 'SECURITY_INCIDENT' } })).status).toBe(204);
    expect(await clock.byTestClock(suspended.slug)).toEqual({ ok: false, refused: 'not_offboarding' });
    expect(await statusOf(suspended.id)).toBe('SUSPENDED');

    const cancelled = await institution('ONBOARDING');
    await start(owner, cancelled.id);
    expect((await cons('POST', `/tenants/${cancelled.id}/offboarding/cancel`, { cookie: owner })).status).toBe(204);
    expect(await clock.byTestClock(cancelled.slug)).toEqual({ ok: false, refused: 'not_offboarding' });
    expect(await statusOf(cancelled.id)).toBe('ONBOARDING');

    expect(await clock.byTestClock(`${PREFIX}nobody`)).toEqual({ ok: false, refused: 'no_tenant' });
    expect(await archived(wentLive.id)).toHaveLength(0);
  });

  it('the job: the slug twice, exit 3 when refused, 0 when done, as the app roles', async () => {
    const owner = await as('OWNER');
    const t = await institution('ONBOARDING');
    await start(owner, t.id);
    expect(await testClock(['archive', t.slug])).toBe(2);
    expect(await testClock(['archive', t.slug, '--confirm', `${t.slug}x`])).toBe(2);
    expect(await statusOf(t.id)).toBe('OFFBOARDING');
    expect(await testClock(['archive', `${PREFIX}nobody`, '--confirm', `${PREFIX}nobody`])).toBe(3);
    expect(await testClock(['archive', t.slug, '--confirm', t.slug])).toBe(0);
    expect(await statusOf(t.id)).toBe('ARCHIVED');
    expect(await testClock(['archive', t.slug, '--confirm', t.slug])).toBe(0);
  });
});
