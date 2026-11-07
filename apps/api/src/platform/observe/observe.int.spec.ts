/**
 * Spec 0031: seeing what happened, against the real platform database, as the console role, through the platform API's
 * own HTTP stack. The database is shared with development and the console role can't delete, so what would stick (a
 * review, a count) is dated in the far future, and the global teardown removes it as the migrator. The chain itself is
 * only read and appended to: tampering is proved on rows in memory (Q16, packages/crypto/src/platform-audit.spec.ts).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { writePlatformAudit } from '@univarse/crypto';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../modules/identity/password.js';
import { base32Decode, hotp, timeStep } from '../../modules/identity/totp.js';
import type { Mailer } from '../../shared/infra/mailer.js';
import { NO_TENANT, SecurityRollupWriter } from '../../shared/observability/security-rollup.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { PlatformCredentials } from '../identity/credentials.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';
import { PlatformAccessReviews } from './access-review.js';
import { ChainVerification } from './chain-verification.js';
import { PlatformSecurityView } from './security-view.js';

const PASSWORD = 'Correct-Horse-Battery-9';
const HOST = 'console.univarse.localhost';
const FAR = new Date('2199-06-15T12:00:00Z');
const mailer: Mailer = { send: () => Promise.resolve() };

let app: NestFastifyApplication;
let db: PlatformClient;
let creds: PlatformCredentials;
let ip = '127.0.0.1';
const emails = new Set<string>();

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), { mailer });
  db = app.get(CONSOLE_DB);
  creds = app.get(PlatformCredentials);
});
afterAll(async () => {
  const email = { in: [...emails] };
  await db.platformSession.updateMany({ where: { user: { email }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await db.platformUser.updateMany({ where: { email }, data: { role: 'READ_ONLY', isActive: false } });
  await app.close();
});
beforeEach(() => {
  ip = `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;
});

interface Res {
  status: number;
  body: Record<string, unknown>;
  cookies: Record<string, string>;
}

async function call(method: 'GET' | 'POST', url: string, opts: { cookie?: string; body?: unknown } = {}): Promise<Res> {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/platform/v1${url}`,
      remoteAddress: ip,
      headers: {
        host: HOST,
        ...(method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
    });
  const raw = res.headers['set-cookie'];
  const cookies: Record<string, string> = {};
  for (const c of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const [pair = ''] = c.split(';');
    const [name = '', ...value] = pair.split('=');
    cookies[name] = value.join('=');
  }
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {}, cookies };
}

interface Member {
  id: string;
  email: string;
  secret: string;
  cookie: string;
}
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

async function member(role: 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY'): Promise<Member> {
  const email = `observe-${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  emails.add(email);
  const { id } = await db.platformUser.create({ data: { email, displayName: `Observer ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  let secret = '';
  await db.$transaction(async (tx) => {
    secret = (await creds.beginFactor(tx, { id, email })).secret;
    expect(await creds.confirmFactor(tx, id, totp(secret, -1))).toBe(true);
  });
  const login = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
  const challenge = `__Host-uv_console_mfa=${login.cookies['__Host-uv_console_mfa'] ?? ''}`;
  const res = await call('POST', '/auth/mfa', { cookie: challenge, body: { code: totp(secret) } });
  return { id, email, secret, cookie: `__Host-uv_console_sid=${res.cookies['__Host-uv_console_sid'] ?? ''}` };
}

const rowsOf = (r: Res) => r.body.data as { id: string; seq: string; action: string; actor: { id: string | null; name: string | null }; metadata: Record<string, unknown> }[];
const nextCursor = (r: Res) => (r.body.page as { nextCursor: string | null }).nextCursor;
const viewedBy = (id: string) => db.platformAuditEvent.count({ where: { actorId: id, action: 'platform.audit.viewed' } });

describe('[0031 Q1] who sees what', () => {
  it('SUPPORT and FINANCE see none of it: 404, as an unknown route', async () => {
    for (const role of ['SUPPORT', 'FINANCE'] as const) {
      const m = await member(role);
      for (const url of ['/audit', '/audit/verification', '/security', '/access-review']) expect([role, url, (await call('GET', url, { cookie: m.cookie })).status]).toEqual([role, url, 404]);
      expect((await call('POST', '/audit/verification', { cookie: m.cookie })).status).toBe(404);
    }
  });

  it('READ_ONLY reads, but starts no run and attests nothing', async () => {
    const m = await member('READ_ONLY');
    for (const url of ['/audit', '/audit/verification', '/security', '/access-review']) expect((await call('GET', url, { cookie: m.cookie })).status).toBe(200);
    expect((await call('POST', '/audit/verification', { cookie: m.cookie })).status).toBe(404);
    expect((await call('POST', '/access-review', { cookie: m.cookie, body: { snapshotHash: '0'.repeat(64), decisions: [] } })).status).toBe(404);
  });

  it('no session: 401', async () => {
    expect((await call('GET', '/audit')).status).toBe(401);
  });
});

describe('[0031 Q2, Q3, Q4] the audit log', () => {
  it('a new query is audited once, with its filters; following its cursor is not', async () => {
    const m = await member('OWNER');
    const first = await call('GET', `/audit?limit=2&actorId=${m.id}`, { cookie: m.cookie });
    expect(first.status).toBe(200);
    expect(await viewedBy(m.id)).toBe(1);
    const row = await db.platformAuditEvent.findFirst({ where: { actorId: m.id, action: 'platform.audit.viewed' } });
    expect(row?.metadata).toMatchObject({ filters: { actorId: m.id } });
    expect(row?.ip).toBe(ip);
    const cursor = nextCursor(first);
    expect(cursor).toBeTruthy();
    expect((await call('GET', `/audit?limit=2&actorId=${m.id}&cursor=${cursor ?? ''}`, { cookie: m.cookie })).status).toBe(200);
    expect(await viewedBy(m.id)).toBe(1);
  });

  it('pages are newest first, with no gaps or repeats, even while rows are being added', async () => {
    const m = await member('OWNER');
    for (let i = 0; i < 5; i++) await db.$transaction((tx) => writePlatformAudit(tx, { actorId: m.id, action: 'platform.test.paged', tenantId: null, metadata: { i } }));
    const url = `/audit?limit=2&action=platform.test.paged&actorId=${m.id}`;
    const first = await call('GET', url, { cookie: m.cookie });
    // A row added between pages must not shift what follows.
    await db.$transaction((tx) => writePlatformAudit(tx, { actorId: m.id, action: 'platform.test.paged', tenantId: null, metadata: { i: 99 } }));
    const second = await call('GET', `${url}&cursor=${nextCursor(first) ?? ''}`, { cookie: m.cookie });
    const third = await call('GET', `${url}&cursor=${nextCursor(second) ?? ''}`, { cookie: m.cookie });
    const seen = [...rowsOf(first), ...rowsOf(second), ...rowsOf(third)].map((r) => r.metadata.i);
    expect(seen).toEqual([4, 3, 2, 1, 0]);
    expect(nextCursor(third)).toBeNull();
    expect((third.body.page as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('filters by group, by institution and by date', async () => {
    const m = await member('OWNER');
    const group = await call('GET', `/audit?actionGroup=platform.auth&actorId=${m.id}`, { cookie: m.cookie });
    expect(rowsOf(group).length).toBeGreaterThan(0);
    for (const r of rowsOf(group)) expect(r.action.startsWith('platform.auth.')).toBe(true);
    const none = await call('GET', `/audit?tenantId=${NO_TENANT}`, { cookie: m.cookie });
    expect(rowsOf(none)).toEqual([]);
    const future = await call('GET', `/audit?actorId=${m.id}&from=${encodeURIComponent(FAR.toISOString())}`, { cookie: m.cookie });
    expect(rowsOf(future)).toEqual([]);
  });

  it('names the actor from a join: a member, a former member, the system', async () => {
    const m = await member('OWNER');
    const gone = '01a1b1d7-0000-7000-8000-000000000001';
    await db.$transaction((tx) => writePlatformAudit(tx, { actorId: gone, action: 'platform.test.named', tenantId: null, metadata: {} }));
    await db.$transaction((tx) => writePlatformAudit(tx, { actorId: null, action: 'platform.test.named', tenantId: null, metadata: {} }));
    const res = await call('GET', '/audit?action=platform.test.named&limit=2', { cookie: m.cookie });
    expect(rowsOf(res).map((r) => r.actor)).toEqual([
      { id: null, name: null },
      { id: gone, name: null },
    ]);
    const own = await call('GET', `/audit?action=platform.audit.viewed&actorId=${m.id}&limit=1`, { cookie: m.cookie });
    expect(rowsOf(own)[0]?.actor).toEqual({ id: m.id, name: 'Observer OWNER' });
  });

  it('no email in any row the viewer returns', async () => {
    const m = await member('OWNER');
    expect(JSON.stringify(rowsOf(await call('GET', `/audit?actorId=${m.id}`, { cookie: m.cookie })))).not.toContain(m.email);
  });

  it('refuses an unknown parameter and a bad cursor', async () => {
    const m = await member('OWNER');
    expect((await call('GET', '/audit?search=anything', { cookie: m.cookie })).status).toBe(400);
    expect((await call('GET', '/audit?cursor=notacursor', { cookie: m.cookie })).status).toBe(400);
    expect((await call('GET', '/audit?limit=201', { cookie: m.cookie })).status).toBe(400);
  });
});

describe('[0031 Q5, Q6, Q7] verifying the chain', () => {
  it('a member starts it in the background; it passes on the real chain and records its head', async () => {
    const m = await member('OWNER');
    const started = await call('POST', '/audit/verification', { cookie: m.cookie });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ trigger: 'MEMBER', status: 'RUNNING', startedBy: { id: m.id, name: 'Observer OWNER' } });
    await app.get(ChainVerification).finished();
    const after = await call('GET', '/audit/verification', { cookie: m.cookie });
    expect(after.body.broken).toBe(false);
    expect(after.body.latest).toMatchObject({ status: 'PASSED', id: started.body.id, brokenAtSeq: null });
    const run = await db.platformAuditVerification.findUniqueOrThrow({ where: { id: String(started.body.id) } });
    expect(run.headSeq).not.toBeNull();
    expect(run.rowsChecked).toBe(run.headSeq);
    expect(await db.platformAuditEvent.count({ where: { action: 'platform.audit.verified', actorId: m.id } })).toBe(1);
  });

  it('the next run checks the last head, and passes on a chain that only grew', async () => {
    const verify = app.get(ChainVerification);
    const first = await verify.start(null);
    await verify.finished();
    await db.$transaction((tx) => writePlatformAudit(tx, { actorId: null, action: 'platform.test.grown', tenantId: null, metadata: {} }));
    const second = await verify.start(null);
    await verify.finished();
    const [a, b] = await Promise.all([db.platformAuditVerification.findUniqueOrThrow({ where: { id: first.id } }), db.platformAuditVerification.findUniqueOrThrow({ where: { id: second.id } })]);
    expect([a.status, b.status, b.trigger]).toEqual(['PASSED', 'PASSED', 'SCHEDULE']);
    expect(b.headSeq ?? 0n).toBeGreaterThan(a.headSeq ?? 0n);
  });

  it('the schedule stays quiet when a run finished in the last 24 hours', async () => {
    const verify = app.get(ChainVerification);
    await verify.start(null);
    await verify.finished();
    const before = await db.platformAuditVerification.count();
    await verify.startIfDue();
    expect(await db.platformAuditVerification.count()).toBe(before);
    await verify.startIfDue(FAR);
    await verify.finished();
    expect(await db.platformAuditVerification.count()).toBe(before + 1);
  });
});

describe('[0031 Q8, Q9, Q13] security counts', () => {
  const env = () => parseEnv(readFileSync(new URL('../../../../../.env', import.meta.url), 'utf8'));

  it("both the console role and the tenant API's role add to the same minute's row", async () => {
    const tenantSide = createPlatformClient(env().PLATFORM_DATABASE_URL ?? 'postgresql://unset');
    try {
      const at = new Date(FAR.getTime() + randomInt(1, 1_000_000) * 60_000);
      const one = new SecurityRollupWriter(db, 'platform-api');
      const two = new SecurityRollupWriter(tenantSide, 'api');
      for (const w of [one, one, two]) {
        w.counts.add('auth.account.locked', null, at);
        await w.flush();
      }
      const rows = await db.platformSecurityEventRollup.findMany({ where: { event: 'auth.account.locked', minute: new Date(Math.floor(at.getTime() / 60_000) * 60_000) }, orderBy: { source: 'asc' } });
      expect(rows.map((r) => [r.source, r.count])).toEqual([
        ['api', 1],
        ['platform-api', 2],
      ]);
    } finally {
      await tenantSide.$disconnect();
    }
  });

  it('the summary leads with what needs a person, and names institutions by slug', async () => {
    const tenant = await db.tenant.findFirstOrThrow({ select: { id: true, slug: true } });
    const at = new Date(FAR.getTime() + randomInt(1_000_001, 2_000_000) * 60_000);
    const w = new SecurityRollupWriter(db, 'platform-api');
    w.counts.add('files.scan.malware_detected', tenant.id, at);
    for (let i = 0; i < 3; i++) w.counts.add('auth.rate_limited', tenant.id, at);
    w.counts.add('platform.allowlist_refused', null, at);
    await w.flush();
    const s = await app.get(PlatformSecurityView).summary({ window: '24h' }, new Date(at.getTime() + 60_000));
    expect(s.totals).toEqual({ act: 1, watch: 1, note: 3 });
    expect(s.events.map((e) => [e.event, e.level, e.count])).toEqual([
      ['files.scan.malware_detected', 'act', 1],
      ['platform.allowlist_refused', 'watch', 1],
      ['auth.rate_limited', 'note', 3],
    ]);
    expect(s.institutions).toEqual([{ institution: expect.objectContaining({ id: tenant.id, slug: tenant.slug }) as unknown, act: 1, watch: 0, note: 3 }]);
    const only = await app.get(PlatformSecurityView).summary({ window: '24h', tenantId: tenant.id }, new Date(at.getTime() + 60_000));
    expect(only.totals).toEqual({ act: 1, watch: 0, note: 3 });
  });

  it('the rollup table has no column for a person, an address or a detail', async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_security_event_rollup' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual(['count', 'event', 'last_seen_at', 'minute', 'source', 'tenant_id']);
  });

  it("the tenant API's role can add to rollups but can't delete them, and reads no review or verification", async () => {
    const tenantSide = createPlatformClient(env().PLATFORM_DATABASE_URL ?? 'postgresql://unset');
    try {
      await expect(tenantSide.$executeRaw`DELETE FROM platform_security_event_rollup WHERE minute < '2000-01-01'`).rejects.toThrow();
      await expect(tenantSide.platformAccessReview.count()).rejects.toThrow();
      await expect(tenantSide.platformAuditVerification.count()).rejects.toThrow();
    } finally {
      await tenantSide.$disconnect();
    }
  });
});

describe('[0031 Q15] the access review', () => {
  const load = async (m: Member) => (await call('GET', '/access-review', { cookie: m.cookie })).body as { snapshotHash: string; period: string; status: string; members: { id: string }[]; history: { period: string; changesNeeded: number; reviewer: { id: string } }[] };
  /** A step-up rotates the session, so the member carries the new cookie. */
  const stepUp = async (m: Member, offset: number) => {
    const r = await call('POST', '/me/step-up', { cookie: m.cookie, body: { code: totp(m.secret, offset) } });
    expect(r.status).toBe(204);
    m.cookie = `__Host-uv_console_sid=${r.cookies['__Host-uv_console_sid'] ?? ''}`;
  };
  const keepAll = (members: { id: string }[]) => members.map((x) => ({ memberId: x.id, decision: 'keep' as const }));

  it('attesting needs a step-up', async () => {
    const m = await member('OWNER');
    const page = await load(m);
    const r = await call('POST', '/access-review', { cookie: m.cookie, body: { snapshotHash: page.snapshotHash, decisions: keepAll(page.members) } });
    expect([r.status, r.body.code]).toEqual([428, 'auth.step_up_required']);
  });

  it('a change since the page loaded is refused, and nothing is stored', async () => {
    const m = await member('OWNER');
    await stepUp(m, 1);
    const page = await load(m);
    await member('SUPPORT');
    const count = await db.platformAccessReview.count();
    const r = await call('POST', '/access-review', { cookie: m.cookie, body: { snapshotHash: page.snapshotHash, decisions: keepAll(page.members) } });
    expect([r.status, r.body.code]).toEqual([409, 'access_review.changed']);
    expect(await db.platformAccessReview.count()).toBe(count);
  });

  it('a sign-in since the page loaded is no change', async () => {
    const m = await member('OWNER');
    const before = (await load(m)).snapshotHash;
    const login = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    const challenge = `__Host-uv_console_mfa=${login.cookies['__Host-uv_console_mfa'] ?? ''}`;
    expect((await call('POST', '/auth/mfa', { cookie: challenge, body: { code: totp(m.secret, 1) } })).status).toBe(200);
    expect((await load(m)).snapshotHash).toBe(before);
  });

  it('a decision missing for any member is refused', async () => {
    const m = await member('OWNER');
    await stepUp(m, 1);
    const page = await load(m);
    const r = await call('POST', '/access-review', { cookie: m.cookie, body: { snapshotHash: page.snapshotHash, decisions: keepAll(page.members).slice(1) } });
    expect([r.status, r.body.code]).toEqual([422, 'access_review.incomplete']);
  });

  it('one review a month: stored as attested, audited without its notes, and a second is refused', async () => {
    const m = await member('OWNER');
    const reviews = app.get(PlatformAccessReviews);
    const at = new Date(Date.UTC(2200 + randomInt(0, 700), randomInt(0, 12), 15));
    const actor = { userId: m.id } as Parameters<PlatformAccessReviews['attest']>[0];
    const meta = { ip, userAgent: 'test', requestId: 'r' };
    const page = await reviews.current(at);
    expect(page.status).not.toBe('done');
    const decisions = page.members.map((x, i) => ({ memberId: x.id, decision: i === 0 ? ('change' as const) : ('keep' as const), ...(i === 0 ? { note: 'Reduce this role.' } : {}) }));
    const done = await reviews.attest(actor, { snapshotHash: page.snapshotHash, decisions }, meta, at);
    expect(done.period).toBe(page.period);

    const stored = await db.platformAccessReview.findUniqueOrThrow({ where: { period: page.period } });
    const snapshot = stored.snapshot as { id: string; decision: string; note: string | null }[];
    expect(snapshot).toHaveLength(page.members.length);
    expect(snapshot.find((s) => s.note)).toMatchObject({ decision: 'change', note: 'Reduce this role.' });
    expect(Buffer.from(stored.snapshotHash).toString('hex')).toBe(page.snapshotHash);

    const audit = await db.platformAuditEvent.findFirstOrThrow({ where: { action: 'platform.access_review.attested', actorId: m.id } });
    expect(audit.metadata).toMatchObject({ period: page.period, members: snapshot.length, changesNeeded: 1 });
    expect(JSON.stringify(audit.metadata)).not.toContain('Reduce this role');

    await expect(reviews.attest(actor, { snapshotHash: page.snapshotHash, decisions }, meta, at)).rejects.toMatchObject({ status: 409, code: 'access_review.already_done' });
    expect((await reviews.current(at)).status).toBe('done');
  });

  it("the console role can't change or delete a stored review", async () => {
    await expect(db.$executeRaw`UPDATE platform_access_review SET period = period WHERE period = 'none'`).rejects.toThrow();
    await expect(db.$executeRaw`DELETE FROM platform_access_review WHERE period = 'none'`).rejects.toThrow();
  });
});
