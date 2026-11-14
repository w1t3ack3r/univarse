/**
 * Spec 0037 Q6–Q8 (J10's suspended case): suspending an institution end to end, against the real databases. The console
 * suspends through the platform API's own HTTP stack as the console role; the tenant API answers 423 with the
 * institution's public name and colours; the worker ends every session there and records it; the console's resume
 * waits for that, and after it nobody's old session works. The databases are shared with development, so every
 * institution here is its own (slug `susp-s6-…`), removed at the end.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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
import { WorkerModule } from '../../worker.module.js';
import { hashPassword } from '../identity/password.js';
import { base32Decode, hotp, timeStep } from '../identity/totp.js';
import { SUSPENSION_REVOKE_REASON, SuspensionSessionEnding } from './session-ending.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'susp-s6-';
const PASSWORD = 'Correct-Horse-Battery-9';
const CONSOLE = 'console.univarse.localhost';
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';

let consoleApp: NestFastifyApplication;
let tenantApp: NestFastifyApplication;
let worker: INestApplicationContext;
let consoleDb: PlatformClient;
let migrator: PlatformClient;
let shard: TenantShardClient;
let ending: SuspensionSessionEnding;
let creds: PlatformCredentials;
let poolId: string;
const staff = new Set<string>();
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

/** A console member of this role, signed in and stepped up (one sign-in each: a TOTP step is used once). */
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

/** An institution of its own, live (or onboarding), with a student who can sign in on its address. */
async function institution(status: 'ACTIVE' | 'ONBOARDING' | 'REQUESTED' = 'ACTIVE') {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const host = `${slug}.univarse.localhost`;
  const t = await migrator.tenant.create({ data: { slug, legalName: 'Paused Polytechnic of Testing', shortName: 'PPT', type: 'POLYTECHNIC', ownership: 'STATE', status, shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await migrator.tenantBranding.create({ data: { tenantId: t.id, primaryColor: '#1F4E79' } });
  const db = forTenant(shard, t.id);
  const role = await db.role.create({ data: { tenantId: t.id, key: 'STUDENT', name: 'Student', isSystem: true, permissions: [] }, select: { id: true } });
  const username = `S6-${randomBytes(3).toString('hex').toUpperCase()}`;
  const user = await db.userAccount.create({ data: { tenantId: t.id, username, displayName: 'Test Student', status: 'ACTIVE', passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  await db.roleAssignment.create({ data: { tenantId: t.id, userId: user.id, roleId: role.id, scopeType: 'INSTITUTION' } });
  return { id: t.id, host, username };
}

const refreshTenantCache = () => tenantApp.get(TenantResolver).invalidate();
const studentLogin = async (host: string, username: string) => inject(tenantApp, host, 'POST', '/api/v1/auth/login', { body: { username, password: PASSWORD } });
const studentCookie = (r: Res) => (r.setCookie[0] ?? '').split(';')[0] ?? '';
const me = (host: string, cookie: string) => inject(tenantApp, host, 'GET', '/api/v1/auth/me', { cookie });
const statusOf = async (id: string) => (await migrator.tenant.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const platformActions = async (tenantId: string) => (await migrator.platformAuditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' }, select: { action: true } })).map((a) => a.action);
const suspend = (cookie: string, id: string, body: unknown = { reason: 'SECURITY_INCIDENT' }) => cons('POST', `/tenants/${id}/suspend`, { cookie, body });
const resume = (cookie: string, id: string) => cons('POST', `/tenants/${id}/resume`, { cookie });

beforeAll(async () => {
  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }));
  consoleDb = consoleApp.get(CONSOLE_DB);
  creds = consoleApp.get(PlatformCredentials);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SUSPENSION_INTERVAL_MS: '0', ONBOARDING_CHECK_INTERVAL_MS: '0' });
  tenantApp = await createApp(config);
  worker = await NestFactory.createApplicationContext(WorkerModule.forRoot(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }, 'worker'), { mailer: { send: () => Promise.resolve() }, subscribe: false }), { logger: false });
  ending = worker.get(SuspensionSessionEnding);
});

afterAll(async () => {
  await consoleDb.platformSession.updateMany({ where: { userId: { in: [...staff] }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await consoleDb.platformUser.updateMany({ where: { id: { in: [...staff] } }, data: { role: 'READ_ONLY', isActive: false } });
  await shard.$disconnect();
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await worker.close();
  await tenantApp.close();
  await consoleApp.close();
});

describe('[Q1, Q6] who may suspend, and why', () => {
  it('only OWNER and SUPER_ADMIN, stepped up; to anyone else the routes are absent', async () => {
    const t = await institution();
    for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
      const cookie = await as(role);
      expect([role, (await suspend(cookie, t.id)).status, (await resume(cookie, t.id)).status]).toEqual([role, 404, 404]);
    }
    expect((await suspend(await as('SUPER_ADMIN', false), t.id)).body.code).toBe('auth.step_up_required');
    expect(await statusOf(t.id)).toBe('ACTIVE');
  });

  it('takes a reason from the fixed list only (never non-payment), and a note for "other"', async () => {
    const t = await institution();
    const cookie = await as('OWNER');
    expect((await suspend(cookie, t.id, { reason: 'NON_PAYMENT' })).body.code).toBe('request.invalid');
    expect((await suspend(cookie, t.id, {})).body.code).toBe('request.invalid');
    const noNote = await suspend(cookie, t.id, { reason: 'OTHER' });
    expect([noNote.status, noNote.body.code]).toEqual([422, 'tenant.suspension_note']);
    expect((await suspend(cookie, t.id, { reason: 'OTHER', note: 'x'.repeat(201) })).body.code).toBe('request.invalid');
    expect(await statusOf(t.id)).toBe('ACTIVE');
    expect((await suspend(cookie, t.id, { reason: 'OTHER', note: 'Asked by the board, by phone' })).status).toBe(204);
    // The note stays on the suspension's row: the audit chain says only that there is one.
    const audit = await migrator.platformAuditEvent.findFirstOrThrow({ where: { tenantId: t.id, action: 'platform.tenant.suspended' }, select: { metadata: true } });
    expect(JSON.stringify(audit.metadata)).not.toContain('board');
    expect(audit.metadata).toMatchObject({ reason: 'OTHER', previousStatus: 'ACTIVE', hasNote: true });
  });

  it('starts only from live or onboarding, once; an unknown institution is 404', async () => {
    const cookie = await as('OWNER');
    const requested = await institution('REQUESTED');
    expect((await suspend(cookie, requested.id)).body.code).toBe('tenant.not_suspendable');
    const t = await institution();
    expect((await suspend(cookie, t.id)).status).toBe(204);
    expect((await suspend(cookie, t.id)).body.code).toBe('tenant.not_suspendable');
    expect((await suspend(cookie, '00000000-0000-7000-8000-00000000dead')).status).toBe(404);
    expect((await resume(cookie, requested.id)).body.code).toBe('tenant.not_suspended');
  });
});

describe('[Q6–Q8, J10] a suspension, end to end', () => {
  it('locks everyone out at once, ends every session, and a resume brings back no old session', async () => {
    const t = await institution();
    const login = await studentLogin(t.host, t.username);
    expect(login.status).toBe(200);
    const old = studentCookie(login);
    expect((await me(t.host, old)).status).toBe(200);

    const owner = await as('OWNER');
    expect((await suspend(owner, t.id)).status).toBe(204);
    expect(await statusOf(t.id)).toBe('SUSPENDED');

    // Q8: every request is 423, with the institution's public name and colours, and signing in is refused too.
    refreshTenantCache();
    const blocked = await me(t.host, old);
    expect(blocked.status).toBe(423);
    expect(blocked.body).toMatchObject({ code: 'tenant.suspended', institution: { legalName: 'Paused Polytechnic of Testing', shortName: 'PPT', primaryColor: '#1F4E79', textColor: '#FFFFFF' } });
    expect((await studentLogin(t.host, t.username)).status).toBe(423);

    // Q7: the resume waits for the worker.
    const early = await resume(owner, t.id);
    expect([early.status, early.body.code]).toEqual([409, 'tenant.sessions_ending']);

    await ending.pass();
    const side = await forTenant(shard, t.id).session.findMany({ select: { revokedAt: true, revokeReason: true } });
    expect(side.length).toBeGreaterThan(0);
    expect(side.every((s) => s.revokedAt !== null && s.revokeReason === SUSPENSION_REVOKE_REASON)).toBe(true);
    const row = await migrator.platformTenantSuspension.findFirstOrThrow({ where: { tenantId: t.id }, select: { sessionsEnded: true, sessionsEndedAt: true } });
    expect(row.sessionsEnded).toBe(side.length);
    expect(row.sessionsEndedAt).not.toBeNull();
    const tenantAudit = await forTenant(shard, t.id).auditEvent.findMany({ where: { action: 'auth.sessions.ended_by_suspension' }, select: { actorType: true } });
    expect(tenantAudit).toEqual([{ actorType: 'SYSTEM' }]);

    // Idempotent: a second pass ends nothing more and records nothing more.
    await ending.pass();
    expect((await migrator.platformTenantSuspension.findFirstOrThrow({ where: { tenantId: t.id }, select: { sessionsEnded: true } })).sessionsEnded).toBe(side.length);

    // The console's detail shows it, the note and sessions included.
    const detail = await cons('GET', `/tenants/${t.id}`, { cookie: owner });
    const [shown] = detail.body.suspensions as Record<string, unknown>[];
    expect(shown).toMatchObject({ reason: 'SECURITY_INCIDENT', previousStatus: 'ACTIVE', resumedAt: null, sessionsEnded: side.length });

    expect((await resume(owner, t.id)).status).toBe(204);
    expect(await statusOf(t.id)).toBe('ACTIVE');
    refreshTenantCache();
    expect((await me(t.host, old)).status).toBe(401);
    const again = await studentLogin(t.host, t.username);
    expect(again.status).toBe(200);
    expect((await me(t.host, studentCookie(again))).status).toBe(200);
    expect((await resume(owner, t.id)).body.code).toBe('tenant.not_suspended');

    expect(await platformActions(t.id)).toEqual(['platform.tenant.suspended', 'platform.tenant.sessions_ended', 'platform.tenant.resumed']);
  });

  it('returns an onboarding institution to onboarding, and keeps each suspension in its history', async () => {
    const t = await institution('ONBOARDING');
    const owner = await as('SUPER_ADMIN');
    for (const reason of ['INSTITUTION_ASKED', 'REGULATOR_ORDER'] as const) {
      expect((await suspend(owner, t.id, { reason })).status).toBe(204);
      await ending.pass();
      expect((await resume(owner, t.id)).status).toBe(204);
      expect(await statusOf(t.id)).toBe('ONBOARDING');
    }
    const detail = await cons('GET', `/tenants/${t.id}`, { cookie: owner });
    expect((detail.body.suspensions as { reason: string; resumedAt: string | null }[]).map((s) => [s.reason, s.resumedAt !== null])).toEqual([
      ['REGULATOR_ORDER', true],
      ['INSTITUTION_ASKED', true],
    ]);
  });
});

describe('[Q6, Q7] the database holds the rules too', () => {
  it('a suspension’s record never changes, one is open at a time, and none resumes before its sessions end', async () => {
    const t = await institution();
    expect((await suspend(await as('OWNER'), t.id)).status).toBe(204);
    const row = await migrator.platformTenantSuspension.findFirstOrThrow({ where: { tenantId: t.id }, select: { id: true, suspendedBy: true } });
    await expect(migrator.platformTenantSuspension.update({ where: { id: row.id }, data: { reason: 'OTHER', note: 'rewritten' } })).rejects.toThrow(/can.t change/);
    await expect(migrator.platformTenantSuspension.update({ where: { id: row.id }, data: { resumedAt: new Date(), resumedBy: row.suspendedBy } })).rejects.toThrow(/resume_after_sessions/);
    await expect(
      migrator.$executeRaw`INSERT INTO platform_tenant_suspension (tenant_id, reason, previous_status, suspended_by, updated_at) VALUES (${t.id}::uuid, 'SECURITY_INCIDENT', 'ACTIVE', ${row.suspendedBy}::uuid, now())`,
    ).rejects.toThrow(/open_key/);
    await expect(
      migrator.$executeRaw`INSERT INTO platform_tenant_suspension (tenant_id, reason, previous_status, suspended_by, updated_at) VALUES (${t.id}::uuid, 'NON_PAYMENT', 'ACTIVE', ${row.suspendedBy}::uuid, now())`,
    ).rejects.toThrow(/reason_check/);
    await ending.pass();
    await expect(migrator.platformTenantSuspension.update({ where: { id: row.id }, data: { sessionsEnded: 99 } })).rejects.toThrow(/ended once/);
  });
});
