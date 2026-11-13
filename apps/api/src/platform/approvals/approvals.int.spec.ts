/**
 * Spec 0037 Q2–Q5, Q15 (E4, E25, T24): the approval engine and the inbox against the real platform database, as the
 * console role, through the platform API's own HTTP stack. The database is shared with development (and its real
 * owner), so no test here assumes it knows every member: the solo rule (Q5) is proved in packages/domain, where the
 * staff list is the test's own.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mailer, OutboundEmail } from '../../shared/infra/mailer.js';
import { hashPassword } from '../../modules/identity/password.js';
import { base32Decode, hotp, timeStep } from '../../modules/identity/totp.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';
import { PlatformCredentials } from '../identity/credentials.js';
import { PlatformMailRelay } from '../identity/mail.js';
import type { PlatformActor } from '../identity/types.js';
import { PlatformInboxView } from '../inbox/inbox.service.js';
import { PlatformApprovals, payloadHash } from './approvals.service.js';

const PASSWORD = 'Correct-Horse-Battery-9';
const HOST = 'console.univarse.localhost';
type Role = 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY';

class RecordingMailer implements Mailer {
  readonly sent: OutboundEmail[] = [];
  send(mail: OutboundEmail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

let app: NestFastifyApplication;
let db: PlatformClient;
let creds: PlatformCredentials;
const mailer = new RecordingMailer();
const emails = new Set<string>();

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), { mailer });
  db = app.get(CONSOLE_DB);
  creds = app.get(PlatformCredentials);
});
afterAll(async () => {
  // Shared with development: no OWNER made here stays active (global setup prunes them as the migrator).
  const email = { in: [...emails] };
  await db.platformSession.updateMany({ where: { user: { email }, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await db.platformUser.updateMany({ where: { email }, data: { role: 'READ_ONLY', isActive: false } });
  await app.close();
});
let ip = '127.0.0.1';
beforeEach(() => {
  mailer.sent.length = 0;
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

const sid = (r: Res) => `__Host-uv_console_sid=${r.cookies['__Host-uv_console_sid'] ?? ''}`;
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

interface Member {
  id: string;
  email: string;
  secret: string;
  role: Role;
}

async function member(role: Role): Promise<Member> {
  const email = `${role.toLowerCase()}-${randomBytes(5).toString('hex')}@staff.test`;
  emails.add(email);
  const { id } = await db.platformUser.create({ data: { email, displayName: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  let secret = '';
  await db.$transaction(async (tx) => {
    secret = (await creds.beginFactor(tx, { id, email })).secret;
    expect(await creds.confirmFactor(tx, id, totp(secret, -1))).toBe(true);
  });
  return { id, email, secret, role };
}

/** A full sign-in, with TOTP now. A member signs in once: a second use of the same TOTP step is a replay. */
async function signIn(m: Member): Promise<string> {
  const login = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
  const challenge = `__Host-uv_console_mfa=${login.cookies['__Host-uv_console_mfa'] ?? ''}`;
  const res = await call('POST', '/auth/mfa', { cookie: challenge, body: { code: totp(m.secret, 0) } });
  expect(res.status).toBe(200);
  return sid(res);
}

/** A step-up on that session, with the next TOTP step. */
async function stepUp(m: Member, cookie: string): Promise<string> {
  const up = await call('POST', '/me/step-up', { cookie, body: { code: totp(m.secret, 1) } });
  expect(up.status).toBe(204);
  return sid(up);
}

/** Signed in and stepped up: a session that may do anything its role allows. */
const session = async (m: Member): Promise<string> => stepUp(m, await signIn(m));

/** The engine's service, called as a member, for what HTTP can't do: a decision at a chosen time. */
const actorOf = (m: Member): PlatformActor => ({ userId: m.id, sessionId: 'test', email: m.email, displayName: 'x', role: m.role, isActive: true, mfaAt: new Date(), restricted: false, stepUpAt: new Date() });
const META = { ip: '127.0.0.1', userAgent: undefined };

const ask = (cookie: string, memberId: string, reason = 'They now run platform operations') =>
  call('POST', '/approvals', { cookie, body: { kind: 'staff.make_owner', payload: { memberId }, reason } });
const actionsOf = async (approvalId: string) =>
  (await db.platformAuditEvent.findMany({ where: { metadata: { path: ['approvalId'], equals: approvalId } }, orderBy: { seq: 'asc' } })).map((e) => e.action);
const roleOf = async (id: string) => (await db.platformUser.findUniqueOrThrow({ where: { id }, select: { role: true } })).role;

describe('[Q4] OWNER only through an approval', () => {
  it('a direct change to OWNER and an invitation as OWNER are refused; other role changes still work', async () => {
    const owner = await member('OWNER');
    const target = await member('SUPPORT');
    const cookie = await session(owner);
    expect((await call('POST', `/staff/${target.id}/role`, { cookie, body: { role: 'OWNER' } })).body.code).toBe('staff.owner_needs_approval');
    // Tracked, so a run where the guard is broken (a mutation check) still retires whatever it made.
    const inviteEmail = `x-${randomBytes(4).toString('hex')}@staff.test`;
    emails.add(inviteEmail);
    const invited = await call('POST', '/staff', { cookie, body: { email: inviteEmail, displayName: 'Someone', role: 'OWNER' } });
    expect([invited.status, invited.body.code]).toEqual([422, 'staff.owner_by_approval']);
    expect((await call('POST', `/staff/${target.id}/role`, { cookie, body: { role: 'READ_ONLY' } })).body.role).toBe('READ_ONLY');
    expect(await roleOf(target.id)).toBe('READ_ONLY');
  });
});

describe('[Q2, Q3] request, approve, execute', () => {
  it('another decider approves the hash they were shown; the stored payload runs in that transaction, once', async () => {
    const owner = await member('OWNER');
    const approver = await member('SUPER_ADMIN');
    const target = await member('SUPPORT');
    // Asking needs the kind's own permission, with step-up.
    const unstepped = await signIn(owner);
    expect((await ask(unstepped, target.id)).body.code).toBe('auth.step_up_required');
    const ownerCookie = await stepUp(owner, unstepped);

    const asked = await ask(ownerCookie, target.id);
    expect([asked.status, asked.body.status, asked.body.kind, asked.body.canDecide, asked.body.canCancel]).toEqual([201, 'PENDING', 'staff.make_owner', false, true]);
    const id = String(asked.body.id);
    const hash = String(asked.body.payloadHash);
    expect(hash).toBe(payloadHash({ memberId: target.id }));
    expect(asked.body.subject).toEqual({ id: target.id, name: 'Test SUPPORT' });
    // The same request again, while one waits, is refused.
    expect((await ask(ownerCookie, target.id)).body.code).toBe('approval.already_pending');

    // The requester can't approve it, with the right hash or not.
    expect((await call('POST', `/approvals/${id}/approve`, { cookie: ownerCookie, body: { payloadHash: hash } })).body.code).toBe('approval.own_request');

    // A decider needs a fresh step-up, then the hash they were shown.
    const approverPlain = await signIn(approver);
    expect((await call('GET', `/approvals/${id}`, { cookie: approverPlain })).body.canDecide).toBe(true);
    expect((await call('POST', `/approvals/${id}/approve`, { cookie: approverPlain, body: { payloadHash: hash } })).body.code).toBe('auth.step_up_required');
    const approverCookie = await stepUp(approver, approverPlain);
    const swapped = await call('POST', `/approvals/${id}/approve`, { cookie: approverCookie, body: { payloadHash: payloadHash({ memberId: approver.id }) } });
    expect([swapped.status, swapped.body.code]).toEqual([409, 'approval.payload_changed']);
    expect(await roleOf(target.id)).toBe('SUPPORT');

    const done = await call('POST', `/approvals/${id}/approve`, { cookie: approverCookie, body: { payloadHash: hash } });
    expect([done.status, done.body.status, (done.body.decidedBy as { id: string }).id]).toEqual([200, 'EXECUTED', approver.id]);
    expect(await roleOf(target.id)).toBe('OWNER');
    expect(await actionsOf(id)).toEqual(['platform.approval.requested', 'platform.staff.role_changed', 'platform.approval.approved']);

    // Single use: no second approval, no rejection after it, no cancellation.
    expect((await call('POST', `/approvals/${id}/approve`, { cookie: approverCookie, body: { payloadHash: hash } })).body.code).toBe('approval.not_pending');
    expect((await call('POST', `/approvals/${id}/reject`, { cookie: approverCookie })).body.code).toBe('approval.not_pending');
    expect((await call('POST', `/approvals/${id}/cancel`, { cookie: ownerCookie })).body.code).toBe('approval.not_pending');

    // The member made OWNER and the requester are told; no address or reason enters the audit chain.
    await app.get(PlatformMailRelay).drain();
    expect(mailer.sent.find((m) => m.to === target.email)?.text).toMatch(/changed from SUPPORT to OWNER, approved by two members/);
    expect(mailer.sent.filter((m) => m.to === owner.email).map((m) => m.text)).toContainEqual(expect.stringMatching(/was approved and done/));
    const audit = JSON.stringify((await db.platformAuditEvent.findMany({ where: { metadata: { path: ['approvalId'], equals: id } } })).map((e) => e.metadata));
    expect(audit).not.toContain(target.email);
    expect(audit).not.toContain('platform operations');
  });

  it('nobody approves a request that names them', async () => {
    const owner = await member('OWNER');
    const subject = await member('SUPER_ADMIN');
    const asked = await ask(await session(owner), subject.id);
    const res = await call('POST', `/approvals/${String(asked.body.id)}/approve`, { cookie: await session(subject), body: { payloadHash: String(asked.body.payloadHash) } });
    expect([res.status, res.body.code]).toEqual([409, 'approval.names_you']);
  });

  it('a rejection runs nothing; only the requester cancels, only while it waits', async () => {
    const owner = await member('OWNER');
    const other = await member('SUPER_ADMIN');
    const a = await member('READ_ONLY');
    const b = await member('READ_ONLY');
    const ownerCookie = await session(owner);
    const otherCookie = await session(other);

    const first = await ask(ownerCookie, a.id);
    const rejected = await call('POST', `/approvals/${String(first.body.id)}/reject`, { cookie: otherCookie });
    expect([rejected.body.status, await roleOf(a.id)]).toEqual(['REJECTED', 'READ_ONLY']);

    const second = await ask(ownerCookie, b.id);
    const id = String(second.body.id);
    expect((await call('POST', `/approvals/${id}/cancel`, { cookie: otherCookie })).body.code).toBe('approval.not_pending');
    expect((await call('POST', `/approvals/${id}/cancel`, { cookie: ownerCookie })).body.status).toBe('CANCELLED');
    expect((await call('POST', `/approvals/${id}/approve`, { cookie: otherCookie, body: { payloadHash: String(second.body.payloadHash) } })).body.code).toBe('approval.not_pending');
    expect(await roleOf(b.id)).toBe('READ_ONLY');
  });

  it('a request past its expiry can no longer be approved, and reads as EXPIRED', async () => {
    const owner = await member('OWNER');
    const other = await member('SUPER_ADMIN');
    const target = await member('FINANCE');
    const asked = await ask(await session(owner), target.id);
    const id = String(asked.body.id);
    const later = new Date(Date.now() + 25 * 3_600_000);
    const engine = app.get(PlatformApprovals);
    await expect(engine.approve(actorOf(other), id, String(asked.body.payloadHash), META, later)).rejects.toMatchObject({ code: 'approval.expired' });
    expect((await engine.get(actorOf(owner), id, later)).status).toBe('EXPIRED');
    expect(await roleOf(target.id)).toBe('FINANCE');
  });

  it('a world that changed since the asking fails the request with a fixed code, and changes nothing', async () => {
    const owner = await member('OWNER');
    const other = await member('SUPER_ADMIN');
    const target = await member('SUPPORT');
    const ownerCookie = await session(owner);
    const asked = await ask(ownerCookie, target.id);
    await call('POST', `/staff/${target.id}/deactivate`, { cookie: ownerCookie });
    const res = await call('POST', `/approvals/${String(asked.body.id)}/approve`, { cookie: await session(other), body: { payloadHash: String(asked.body.payloadHash) } });
    expect([res.body.status, res.body.failureCode]).toEqual(['FAILED', 'subject_inactive']);
    expect(await roleOf(target.id)).toBe('SUPPORT');
  });

  it('a requester who lost the right to ask since then gets nothing done by proxy', async () => {
    const owner = await member('OWNER');
    const owner2 = await member('OWNER');
    const other = await member('SUPER_ADMIN');
    const target = await member('SUPPORT');
    const asked = await ask(await session(owner), target.id);
    await call('POST', `/staff/${owner.id}/role`, { cookie: await session(owner2), body: { role: 'SUPPORT' } });
    const res = await call('POST', `/approvals/${String(asked.body.id)}/approve`, { cookie: await session(other), body: { payloadHash: String(asked.body.payloadHash) } });
    expect([res.body.status, res.body.failureCode]).toEqual(['FAILED', 'state_conflict']);
    expect(await roleOf(target.id)).toBe('SUPPORT');
  });

  it('a request that would change nothing is refused at the asking', async () => {
    const owner = await member('OWNER');
    const already = await member('OWNER');
    const cookie = await session(owner);
    expect((await ask(cookie, already.id)).body.code).toBe('approval.not_applicable');
    expect((await ask(cookie, owner.id)).body.code).toBe('staff.own_account');
    expect((await ask(cookie, '00000000-0000-7000-8000-00000000dead')).status).toBe(404);
  });
});

describe('[Q1, T24] who sees and decides', () => {
  it('a role without the decide permission sees only its own requests and gets 404 on anyone else’s', async () => {
    const owner = await member('OWNER');
    const asked = await ask(await session(owner), (await member('READ_ONLY')).id);
    const id = String(asked.body.id);
    for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY'] as const) {
      const cookie = await session(await member(role));
      expect((await call('GET', `/approvals/${id}`, { cookie })).status).toBe(404);
      expect((await call('POST', `/approvals/${id}/approve`, { cookie, body: { payloadHash: String(asked.body.payloadHash) } })).status).toBe(404);
      expect((await call('POST', `/approvals/${id}/reject`, { cookie })).status).toBe(404);
      expect((await call('GET', '/approvals', { cookie })).body.data).toEqual([]);
      // Nor may they ask: staff.manage is OWNER's.
      expect((await ask(cookie, owner.id)).status).toBe(404);
    }
  });

  it('the database holds the rules too: what the console may write, and a request that moves forward once, for every role', async () => {
    const owner = await member('OWNER');
    const asked = await ask(await session(owner), (await member('READ_ONLY')).id);
    const id = String(asked.body.id);
    // The console role: no grant on the request itself, no delete, and the not-own check.
    await expect(db.$executeRaw`UPDATE platform_approval SET payload = '{}'::jsonb WHERE id = ${id}::uuid`).rejects.toThrow(/permission denied/);
    await expect(db.$executeRaw`DELETE FROM platform_approval WHERE id = ${id}::uuid`).rejects.toThrow(/permission denied/);
    await expect(db.$executeRaw`UPDATE platform_approval SET decided_by = requested_by, decided_at = now(), status = 'REJECTED' WHERE id = ${id}::uuid`).rejects.toThrow(/platform_approval_not_own_check/);
    // The trigger holds even for the tables' owner.
    const migrator = createPlatformClient(String(process.env.PLATFORM_MIGRATOR_URL));
    try {
      await expect(migrator.$executeRaw`UPDATE platform_approval SET payload = '{}'::jsonb WHERE id = ${id}::uuid`).rejects.toThrow(/can't change once made/);
      await db.$executeRaw`UPDATE platform_approval SET status = 'CANCELLED' WHERE id = ${id}::uuid`;
      await expect(migrator.$executeRaw`UPDATE platform_approval SET status = 'PENDING' WHERE id = ${id}::uuid`).rejects.toThrow(/moves forward once/);
    } finally {
      await migrator.$disconnect();
    }
  });
});

describe('[Q15] the inbox', () => {
  it('each person sees what they can act on, and an item leaves when its cause is resolved', async () => {
    const owner = await member('OWNER');
    const decider = await member('SUPER_ADMIN');
    const target = await member('FINANCE');
    const support = await member('SUPPORT');
    const ownerCookie = await session(owner);
    const deciderCookie = await signIn(decider);
    const supportCookie = await signIn(support);
    const asked = await ask(ownerCookie, target.id);
    const id = String(asked.body.id);

    const waiting = (items: unknown) => (items as { type: string; approvalId?: string }[]).filter((i) => i.approvalId === id).map((i) => i.type);
    expect(waiting((await call('GET', '/inbox', { cookie: deciderCookie })).body.items)).toEqual(['approval_waiting']);
    expect(waiting((await call('GET', '/inbox', { cookie: ownerCookie })).body.items)).toEqual([]);
    expect(waiting((await call('GET', '/inbox', { cookie: supportCookie })).body.items)).toEqual([]);

    // A step-up replaces the session's cookie.
    const deciderStepped = await stepUp(decider, deciderCookie);
    expect((await call('POST', `/approvals/${id}/reject`, { cookie: deciderStepped })).body.status).toBe('REJECTED');
    expect(waiting((await call('GET', '/inbox', { cookie: deciderStepped })).body.items)).toEqual([]);
    const mine = (await call('GET', '/inbox', { cookie: ownerCookie })).body.items as { type: string; approvalId?: string; status?: string }[];
    expect(mine.filter((i) => i.approvalId === id).map((i) => [i.type, i.status])).toEqual([['approval_decided', 'REJECTED']]);
  });

  it('"act" security events reach those who read security, not the others', async () => {
    const inbox = app.get(PlatformInboxView);
    // Far future (pruned by global setup, invisible to the owner's console), under an institution id of this test's own,
    // so another test's rows in the same window can't be counted here.
    const at = new Date('2100-07-19T03:17:00Z');
    const tenantId = randomUUID();
    await db.platformSecurityEventRollup.create({ data: { minute: at, event: 'files.scan.malware_detected', source: 'api', tenantId, count: 3, lastSeenAt: at } });
    await db.platformSecurityEventRollup.create({ data: { minute: at, event: 'auth.rate_limited', source: 'api', tenantId, count: 9, lastSeenAt: at } });
    const now = new Date(at.getTime() + 60_000);
    const security = (r: Awaited<ReturnType<PlatformInboxView['read']>>) => r.items.filter((i) => i.type === 'security_act' && i.tenant?.id === tenantId);
    expect(security(await inbox.read(actorOf(await member('OWNER')), now))).toEqual([
      { type: 'security_act', event: 'files.scan.malware_detected', count: 3, lastSeenAt: at.toISOString(), tenant: { id: tenantId, slug: null, name: null } },
    ]);
    expect(security(await inbox.read(actorOf(await member('SUPPORT')), now))).toEqual([]);
  });
});
