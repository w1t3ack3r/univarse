/**
 * Spec 0037 Q13–Q15 (E19, T34): incidents end to end, against the real databases. The console opens, updates, resolves
 * and follows up through the platform API's own HTTP stack as the console role; the tenant API shows each affected
 * institution the incident's latest public text and nothing else (no internal note, follow-up or personal-data flag:
 * its role can't read them); the timeline is append-only; the inbox lists open incidents and maintenance about to start
 * to those who can act. Institutions here are their own (slug `inc-…`), removed at the end.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../bootstrap.js';
import { loadConfig } from '../../config/config.js';
import { IncidentBoard } from '../../modules/notices/incident-board.service.js';
import { hashPassword } from '../../modules/identity/password.js';
import { base32Decode, hotp, timeStep } from '../../modules/identity/totp.js';
import { TenantResolver } from '../../shared/tenancy/tenant-resolver.service.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { pruneTestTenants } from '../../testing/tenant-cleanup.js';
import { PlatformCredentials } from '../identity/credentials.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PREFIX = 'inc-s6-';
const PASSWORD = 'Correct-Horse-Battery-9';
const CONSOLE = 'console.univarse.localhost';
const H = 3_600_000;
const NOTE = 'Root cause: a misconfigured pool on shard 2 (staff only)';
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';

let consoleApp: NestFastifyApplication;
let tenantApp: NestFastifyApplication;
let consoleDb: PlatformClient;
let migrator: PlatformClient;
let creds: PlatformCredentials;
let poolId: string;
const staff = new Set<string>();
const cookies = new Map<Role, string>();
const notices: string[] = [];

const ip = () => `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

interface Res {
  status: number;
  body: Record<string, unknown>;
  raw: string;
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
  return { status: res.statusCode, raw: res.body, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, headers: res.headers, setCookie: Array.isArray(raw) ? raw : raw ? [raw] : [] };
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

async function institution(status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED' = 'ACTIVE') {
  const slug = `${PREFIX}${randomBytes(4).toString('hex')}`;
  const host = `${slug}.univarse.localhost`;
  const t = await migrator.tenant.create({ data: { slug, legalName: `Incident Test ${slug}`, shortName: slug.slice(-8).toUpperCase(), type: 'UNIVERSITY', ownership: 'STATE', status, shardId: poolId }, select: { id: true } });
  await migrator.tenantDomain.create({ data: { tenantId: t.id, hostname: host, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  return { id: t.id, host };
}

const opening = (tenantIds: string[], over: Record<string, unknown> = {}) => ({
  title: 'Results pages slow to load',
  severity: 'SEV2',
  scope: 'TENANTS',
  tenantIds,
  personalData: 'NO',
  startedAt: new Date(Date.now() - H).toISOString(),
  awareAt: new Date(Date.now() - H / 2).toISOString(),
  publicText: 'We are looking into slow results pages.',
  internalNote: NOTE,
  ...over,
});
const banners = async (host: string) => {
  tenantApp.get(TenantResolver).invalidate();
  tenantApp.get(IncidentBoard).invalidate();
  const r = await inject(tenantApp, host, 'GET', '/api/v1/tenant/incidents');
  expect(r.status).toBe(200);
  return { list: r.body.data as { id: string; title: string; status: string; latest: { text: string } }[], raw: r.raw };
};
const post = (cookie: string, id: string, version: number, body: Record<string, unknown>) =>
  cons('POST', `/incidents/${id}/updates`, { cookie, ifMatch: `"v${String(version)}"`, body: { status: 'IDENTIFIED', severity: 'SEV2', personalData: 'NO', publicText: 'Found it.', ...body } });

beforeAll(async () => {
  consoleApp = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }));
  consoleDb = consoleApp.get(CONSOLE_DB);
  creds = consoleApp.get(PlatformCredentials);
  migrator = createPlatformClient(process.env.PLATFORM_MIGRATOR_URL!);
  poolId = (await migrator.shard.findUniqueOrThrow({ where: { name: 'pool-01' }, select: { id: true } })).id;
  tenantApp = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
});

afterAll(async () => {
  await migrator.platformNoticeDelivery.deleteMany({ where: { noticeId: { in: notices } } });
  await migrator.platformNotice.deleteMany({ where: { id: { in: notices } } });
  await consoleDb.platformSession.updateMany({ where: { userId: { in: [...staff] }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await consoleDb.platformUser.updateMany({ where: { id: { in: [...staff] } }, data: { role: 'READ_ONLY', isActive: false } });
  await migrator.$disconnect();
  await pruneTestTenants({ platformMigratorUrl: process.env.PLATFORM_MIGRATOR_URL, tenantMigratorUrl: process.env.TENANT_POOL_01_MIGRATOR_URL }, PREFIX);
  await tenantApp.close();
  await consoleApp.close();
});

describe('[Q1, Q13] who runs incidents', () => {
  it('SUPPORT opens one; FINANCE and READ_ONLY read only; a session without a step-up is asked for one', async () => {
    const a = await institution();
    const opened = await cons('POST', '/incidents', { cookie: await as('SUPPORT'), body: opening([a.id]) });
    expect(opened.status).toBe(201);
    for (const role of ['FINANCE', 'READ_ONLY'] as const) {
      const cookie = await as(role);
      expect([role, (await cons('GET', `/incidents/${opened.body.id as string}`, { cookie })).status]).toEqual([role, 200]);
      expect([role, (await cons('POST', '/incidents', { cookie, body: opening([a.id]) })).status]).toEqual([role, 404]);
      expect([role, (await post(cookie, opened.body.id as string, 0, {})).status]).toEqual([role, 404]);
    }
    expect((await cons('POST', '/incidents', { cookie: await as('SUPER_ADMIN', false), body: opening([a.id]) })).body.code).toBe('auth.step_up_required');
  });

  it('refuses an incomplete opening, and one affecting no institution with people', async () => {
    const owner = await as('OWNER');
    const bad = await cons('POST', '/incidents', { cookie: owner, body: opening([], { title: 'x', awareAt: new Date(Date.now() - 2 * H).toISOString() }) });
    expect(bad.body.code).toBe('incident.invalid');
    expect((bad.body.errors as { code: string }[]).map((e) => e.code).sort()).toEqual(['aware_before_start', 'tenants_required', 'title_length']);
    const archived = await institution('ARCHIVED');
    expect((await cons('POST', '/incidents', { cookie: owner, body: opening([archived.id]) })).body.code).toBe('incident.no_institutions');
  });
});

describe('[Q13, Q14, T34] an incident at its institutions', () => {
  it('shows its latest public text at the affected institution only, never the internal note, and follows each update', async () => {
    const [a, b] = [await institution(), await institution()];
    const owner = await as('OWNER');
    const opened = await cons('POST', '/incidents', { cookie: owner, body: opening([a.id], { publicText: '<script>alert(1)</script> Slow pages.' }) });
    const id = opened.body.id as string;
    let seen = await banners(a.host);
    expect(seen.list.map((i) => [i.id, i.status, i.latest.text])).toEqual([[id, 'INVESTIGATING', '<script>alert(1)</script> Slow pages.']]);
    expect(seen.raw).not.toContain('Root cause');
    expect((await banners(b.host)).list.map((i) => i.id)).not.toContain(id);

    const updated = await post(owner, id, opened.body.version as number, { publicText: 'We found the cause and are fixing it.', internalNote: 'Pool resized (staff only).' });
    expect(updated.status).toBe(200);
    seen = await banners(a.host);
    expect(seen.list[0]).toMatchObject({ status: 'IDENTIFIED', latest: { text: 'We found the cause and are fixing it.' } });
    expect(seen.raw).not.toContain('staff only');
    // Every update told the affected institution's cache (opening and the update).
    const events = await migrator.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM cache_invalidation_event WHERE tenant_id = ${a.id}::uuid AND source LIKE 'platform_incident_tenant:%'`;
    expect(Number(events[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);
    // A stale view can't post.
    expect((await post(owner, id, 0, {})).status).toBe(412);
  });

  it('resolving is final, the follow-up comes after it, and both stay in the console', async () => {
    const a = await institution();
    const owner = await as('OWNER');
    const opened = await cons('POST', '/incidents', { cookie: owner, body: opening([a.id]) });
    const id = opened.body.id as string;
    const early = await cons('PUT', `/incidents/${id}/followup`, { cookie: owner, ifMatch: `"v${String(opened.body.version as number)}"`, body: { what: 'x', actions: 'y' } });
    expect(early.body.code).toBe('incident.not_resolved');
    const resolved = await post(owner, id, opened.body.version as number, { status: 'RESOLVED', publicText: 'Fixed. Pages load normally.' });
    expect(resolved.body).toMatchObject({ status: 'RESOLVED' });
    expect(resolved.body.resolvedAt).not.toBeNull();
    // Still shown for a day after resolving (Q14).
    expect((await banners(a.host)).list[0]).toMatchObject({ id, status: 'RESOLVED' });
    expect((await post(owner, id, resolved.body.version as number, {})).body.code).toBe('incident.resolved');
    const followup = await cons('PUT', `/incidents/${id}/followup`, { cookie: owner, ifMatch: `"v${String(resolved.body.version as number)}"`, body: { what: 'A pool was too small for the peak.', actions: 'Resized; alert added.' } });
    expect(followup.body.followup).toEqual({ what: 'A pool was too small for the peak.', actions: 'Resized; alert added.' });
    expect((await banners(a.host)).raw).not.toContain('pool was too small');
    const actions = (await migrator.platformAuditEvent.findMany({ where: { metadata: { path: ['incidentId'], equals: id } }, orderBy: { seq: 'asc' }, select: { action: true, metadata: true } }));
    expect(actions.map((x) => x.action)).toEqual(['platform.incident.opened', 'platform.incident.resolved', 'platform.incident.followup_recorded']);
    expect(JSON.stringify(actions)).not.toContain('Fixed.');
  });

  it('shows the 72-hour clock when personal data may be involved, from awareness', async () => {
    const a = await institution();
    const owner = await as('OWNER');
    const awareAt = new Date(Date.now() - H / 2);
    const opened = await cons('POST', '/incidents', { cookie: owner, body: opening([a.id], { personalData: 'UNKNOWN', awareAt: awareAt.toISOString() }) });
    expect(new Date(opened.body.breachDeadline as string).getTime()).toBe(awareAt.getTime() + 72 * H);
    const cleared = await post(owner, opened.body.id as string, opened.body.version as number, { personalData: 'NO' });
    expect(cleared.body.breachDeadline).toBeNull();
  });
});

describe('[Q13] the database holds the rules too', () => {
  it('the timeline is append-only and the opening never changes, for every role; the tenant API can read no note', async () => {
    const a = await institution();
    const opened = await cons('POST', '/incidents', { cookie: await as('OWNER'), body: opening([a.id]) });
    const id = opened.body.id as string;
    const [u] = await migrator.platformIncidentUpdate.findMany({ where: { incidentId: id }, select: { id: true } });
    await expect(migrator.platformIncidentUpdate.update({ where: { id: u!.id }, data: { publicText: 'rewritten' } })).rejects.toThrow(/append-only/);
    await expect(migrator.platformIncidentUpdate.delete({ where: { id: u!.id } })).rejects.toThrow(/append-only/);
    await expect(migrator.platformIncident.update({ where: { id }, data: { title: 'Renamed' } })).rejects.toThrow(/opening/);
    const app = createPlatformClient(process.env.PLATFORM_DATABASE_URL!);
    try {
      for (const [table, column, expected] of [
        ['platform_incident_update', 'internal_note', false],
        ['platform_incident_update', 'public_text', true],
        ['platform_incident', 'followup_what', false],
        ['platform_incident', 'personal_data', false],
        ['platform_incident', 'opened_by', false],
      ] as const) {
        const [row] = await app.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT has_column_privilege(current_user, '${table}', '${column}', 'SELECT') AS ok`);
        expect([table, column, row?.ok]).toEqual([table, column, expected]);
      }
    } finally {
      await app.$disconnect();
    }
  });
});

describe('[Q15] the inbox', () => {
  it('lists open incidents to those who run them, and maintenance starting within a day to those who publish', async () => {
    const a = await institution();
    const owner = await as('OWNER');
    const opened = await cons('POST', '/incidents', { cookie: owner, body: opening([a.id], { severity: 'SEV1', personalData: 'YES' }) });
    const id = opened.body.id as string;
    // Maintenance in two hours, by hand (the console's own journey publishes through the console).
    const author = staff.values().next().value!;
    const now = Date.now();
    const n = await migrator.platformNotice.create({
      data: { kind: 'MAINTENANCE', title: 'Planned maintenance soon', body: 'Brief outage.', audience: 'TENANTS', tenantIds: [a.id], startsAt: new Date(now + 2 * H), endsAt: new Date(now + 3 * H), createdBy: author },
      select: { id: true },
    });
    notices.push(n.id);
    await migrator.platformNotice.update({ where: { id: n.id }, data: { status: 'PUBLISHED', publishedAt: new Date(now), publishedBy: author, shownUntil: new Date(now + 3 * H) } });
    await migrator.platformNoticeDelivery.create({ data: { noticeId: n.id, tenantId: a.id } });

    const inbox = async (role: Role) => (await cons('GET', '/inbox', { cookie: await as(role) })).body.items as { type: string; incidentId?: string; noticeId?: string; breachDeadline?: string | null }[];
    const support = await inbox('SUPPORT');
    expect(support.find((i) => i.incidentId === id)).toMatchObject({ type: 'incident_open' });
    expect(support.find((i) => i.incidentId === id)?.breachDeadline).not.toBeNull();
    expect(support.some((i) => i.noticeId === n.id && i.type === 'maintenance_soon')).toBe(true);
    const finance = await inbox('FINANCE');
    expect(finance.some((i) => i.type === 'incident_open' || i.type === 'maintenance_soon')).toBe(false);

    await post(owner, id, opened.body.version as number, { status: 'RESOLVED', severity: 'SEV1', personalData: 'YES', publicText: 'Fixed.' });
    expect((await inbox('SUPPORT')).some((i) => i.incidentId === id)).toBe(false);
  });
});
