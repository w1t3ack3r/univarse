/**
 * Spec 0028: platform identity against the real platform database, as the console role, through the platform API's
 * own HTTP stack (walls, CSRF, guard). Prereqs: `pnpm db:setup` (which writes .env.console) and `pnpm db:migrate`.
 * The database is shared, so every member here has an email of its own, and no test assumes it holds the only OWNER.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PlatformClient } from '@univarse/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Mailer, OutboundEmail } from '../../shared/infra/mailer.js';
import { hashPassword } from '../../modules/identity/password.js';
import { base32Decode, hotp, timeStep } from '../../modules/identity/totp.js';
import { platformTestConfig } from '../../testing/platform-env.js';
import { createPlatformApp } from '../platform-app.js';
import { CONSOLE_DB } from '../platform-config.js';
import { PlatformCredentials } from './credentials.js';
import { PlatformMailRelay } from './mail.js';
import { createFirstOwner } from './owner.js';
import { LOCK_AFTER_FAILURES, MAX_SESSIONS } from './types.js';

const PASSWORD = 'Correct-Horse-Battery-9'; // the tenant tests' own (int-harness.ts)
const HOST = 'console.univarse.localhost';

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

beforeAll(async () => {
  // The loopback range, so each test signs in from an address of its own (the per-address limit, Q9, is real here).
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), { mailer });
  db = app.get(CONSOLE_DB);
  creds = app.get(PlatformCredentials);
});
afterAll(async () => {
  await app.close();
});
let ip = '127.0.0.1';
beforeEach(() => {
  mailer.sent.length = 0;
  ip = `127.${String(randomInt(1, 255))}.${String(randomInt(0, 255))}.${String(randomInt(1, 255))}`;
});

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Res {
  status: number;
  body: Record<string, unknown>;
  cookies: Record<string, string>;
}

async function call(method: 'GET' | 'POST' | 'DELETE', url: string, opts: { cookie?: string; body?: unknown; csrf?: boolean } = {}): Promise<Res> {
  const res = await app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/platform/v1${url}`,
      remoteAddress: ip,
      headers: {
        host: HOST,
        ...(opts.csrf === false || method === 'GET' ? {} : { 'sec-fetch-site': 'same-origin' }),
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

// ── Members ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  email: string;
  secret: string;
}

const uniqueEmail = (tag: string) => `${tag}-${randomBytes(5).toString('hex')}@staff.test`;
/** A TOTP code `offset` steps from now: each use of a factor needs a newer step than the last (the replay guard). */
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

/** An activated member with a confirmed factor (confirmed with the previous step, leaving now and next for use). */
async function member(role: 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE' | 'READ_ONLY', opts: { factor?: boolean } = {}): Promise<Member> {
  const email = uniqueEmail(role.toLowerCase());
  const { id } = await db.platformUser.create({ data: { email, displayName: `Test ${role}`, role, passwordHash: await hashPassword(PASSWORD) }, select: { id: true } });
  let secret = '';
  if (opts.factor !== false) {
    await db.$transaction(async (tx) => {
      secret = (await creds.beginFactor(tx, { id, email })).secret;
      expect(await creds.confirmFactor(tx, id, totp(secret, -1))).toBe(true);
    });
  }
  return { id, email, secret };
}

/** A full sign-in: password, then TOTP at `offset`. Returns the session cookie. */
async function signIn(m: Member, offset = 0, deviceCookie?: string): Promise<{ cookie: string; res: Res }> {
  const login = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
  expect(login.body).toEqual({ next: 'mfa' });
  const challenge = `__Host-uv_console_mfa=${login.cookies['__Host-uv_console_mfa'] ?? ''}`;
  const res = await call('POST', '/auth/mfa', { cookie: [challenge, deviceCookie].filter(Boolean).join('; '), body: { code: totp(m.secret, offset) } });
  expect(res.status).toBe(200);
  return { cookie: sid(res), res };
}

async function steppedUp(m: Member, cookie: string, offset: number): Promise<string> {
  const r = await call('POST', '/me/step-up', { cookie, body: { code: totp(m.secret, offset) } });
  expect(r.status).toBe(204);
  return sid(r);
}

const auditOf = (actorId: string) => db.platformAuditEvent.findMany({ where: { actorId }, orderBy: { seq: 'asc' } });
const actions = async (actorId: string) => (await auditOf(actorId)).map((e) => e.action);
const drain = () => app.get(PlatformMailRelay).drain();

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('[Q6, Q7] activation, then TOTP before anything else', () => {
  it('a code and a password give an enrolment-only session; only after TOTP and the recovery codes is it full', async () => {
    const email = uniqueEmail('new');
    const { id } = await db.platformUser.create({ data: { email, displayName: 'New Member', role: 'SUPPORT' }, select: { id: true } });
    const code = await db.$transaction((tx) => creds.issueCode(tx, id, 'ACTIVATION'));

    // A weak password is refused before the code is spent.
    expect((await call('POST', '/auth/activate', { body: { email, code, password: 'short' } })).status).toBe(422);
    const activated = await call('POST', '/auth/activate', { body: { email, code, password: PASSWORD } });
    expect([activated.status, activated.body]).toEqual([200, { next: 'enrol' }]);
    let cookie = sid(activated);
    // The code is single use.
    expect((await call('POST', '/auth/activate', { body: { email, code, password: PASSWORD } })).body.code).toBe('auth.activation_invalid');

    expect((await call('GET', '/me', { cookie })).body.state).toBe('enrol');
    expect((await call('GET', '/me/sessions', { cookie })).body.code).toBe('auth.mfa_enrolment_required');

    const begun = await call('POST', '/me/mfa/enrol', { cookie });
    const secret = String(begun.body.secret);
    expect(String(begun.body.otpauthUri)).toMatch(/^otpauth:\/\/totp\/UniVarse%20Console/);
    expect((await call('POST', '/me/mfa/enrol/confirm', { cookie, body: { code: '000000' } })).body.code).toBe('auth.mfa_invalid');
    const confirmed = await call('POST', '/me/mfa/enrol/confirm', { cookie, body: { code: totp(secret, -1) } });
    expect((confirmed.body.recoveryCodes as string[]).length).toBe(10);
    // The enrolling session is retired; the new one shows the codes and nothing else.
    expect((await call('GET', '/me', { cookie })).status).toBe(401);
    cookie = sid(confirmed);
    expect((await call('GET', '/me', { cookie })).body.state).toBe('recovery-codes');
    expect((await call('GET', '/me/sessions', { cookie })).body.code).toBe('auth.mfa_enrolment_required');

    const saved = await call('POST', '/me/mfa/recovery-codes/saved', { cookie });
    cookie = sid(saved);
    expect((await call('GET', '/me', { cookie })).body).toMatchObject({ state: 'full', role: 'SUPPORT', permissions: ['platform.self'] });
    expect((await call('GET', '/me/sessions', { cookie })).status).toBe(200);
    expect(await actions(id)).toEqual(['platform.auth.activated', 'platform.mfa.enrolment_started', 'platform.mfa.enrolled', 'platform.mfa.recovery_codes_saved']);
  });
});

describe('[Q7, Q8] sign-in needs TOTP; sessions', () => {
  it('a password alone gives a challenge that opens nothing; a wrong code counts toward lockout; the right one, a session', async () => {
    const m = await member('SUPPORT');
    const login = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    expect(login.body).toEqual({ next: 'mfa' });
    expect(login.cookies['__Host-uv_console_sid']).toBeUndefined();
    const challenge = `__Host-uv_console_mfa=${login.cookies['__Host-uv_console_mfa'] ?? ''}`;
    expect((await call('GET', '/me', { cookie: challenge })).status).toBe(401);
    expect((await call('POST', '/auth/mfa', { cookie: challenge, body: { code: '123456' } })).body.code).toBe('auth.mfa_invalid');
    expect((await db.platformUser.findUniqueOrThrow({ where: { id: m.id } })).failedLoginCount).toBe(1);
    const ok = await call('POST', '/auth/mfa', { cookie: challenge, body: { code: totp(m.secret) } });
    expect([ok.status, ok.body]).toEqual([200, { next: 'home' }]);
    expect(ok.cookies['__Host-uv_console_mfa']).toBe('');
    expect((await call('GET', '/me', { cookie: sid(ok) })).body.state).toBe('full');
    // The same TOTP step can't be used twice.
    const again = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    expect((await call('POST', '/auth/mfa', { cookie: `__Host-uv_console_mfa=${again.cookies['__Host-uv_console_mfa'] ?? ''}`, body: { code: totp(m.secret) } })).status).toBe(401);
  });

  it('the cookie is host-only, HttpOnly, Secure and SameSite=Strict', async () => {
    const m = await member('SUPPORT');
    const login = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/api/platform/v1/auth/login', remoteAddress: ip, headers: { host: HOST, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, payload: JSON.stringify({ email: m.email, password: PASSWORD }) });
    expect(String(login.headers['set-cookie'])).toMatch(/^__Host-uv_console_mfa=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=300$/);
  });

  it('a member without a factor (an MFA reset) gets an enrolment-only session from their password', async () => {
    const m = await member('READ_ONLY', { factor: false });
    const login = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    expect(login.body).toEqual({ next: 'enrol' });
    expect((await call('GET', '/staff', { cookie: sid(login) })).body.code).toBe('auth.mfa_enrolment_required');
  });

  it(`at most ${String(MAX_SESSIONS)} sessions: the next sign-in ends the oldest`, async () => {
    const m = await member('SUPPORT');
    const first = await signIn(m, 0);
    // Each sign-in here uses the current step, so the replay guard is cleared between them (it has its own test above).
    const later: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) {
      await db.platformMfaFactor.updateMany({ where: { userId: m.id }, data: { lastUsedStep: null } });
      later.push((await signIn(m, 0)).cookie);
    }
    expect((await call('GET', '/me', { cookie: first.cookie })).status).toBe(401);
    for (const c of later) expect((await call('GET', '/me', { cookie: c })).status).toBe(200);
  });

  it('a tenant session cookie, or a forged one, opens nothing', async () => {
    expect((await call('GET', '/me', { cookie: `__Host-uv_sid=${randomBytes(32).toString('base64url')}` })).status).toBe(401);
    expect((await call('GET', '/me', { cookie: `__Host-uv_console_sid=${randomBytes(32).toString('base64url')}` })).status).toBe(401);
  });

  it('a member ends one of their own sessions; another member\'s is not found', async () => {
    const a = await member('SUPPORT');
    const b = await member('SUPPORT');
    const sa = await signIn(a);
    const sb = await signIn(b);
    const bSessions = (await call('GET', '/me/sessions', { cookie: sb.cookie })).body.data as { id: string }[];
    expect((await call('DELETE', `/me/sessions/${bSessions[0]?.id ?? ''}`, { cookie: sa.cookie })).status).toBe(404);
    expect((await call('DELETE', `/me/sessions/${bSessions[0]?.id ?? ''}`, { cookie: sb.cookie })).status).toBe(204);
    expect((await call('GET', '/me', { cookie: sb.cookie })).status).toBe(401);
  });
});

describe('[Q9] lockout, without revealing whether an account exists', () => {
  it(`${String(LOCK_AFTER_FAILURES)} wrong passwords lock the account; the right one then fails too; the member is emailed`, async () => {
    const m = await member('SUPPORT');
    for (let i = 0; i < LOCK_AFTER_FAILURES; i++) expect((await call('POST', '/auth/login', { body: { email: m.email, password: 'Wrong-Password-12345' } })).status).toBe(401);
    const locked = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    const unknown = await call('POST', '/auth/login', { body: { email: uniqueEmail('nobody'), password: PASSWORD } });
    expect([locked.status, locked.body.code]).toEqual([401, 'auth.invalid_credentials']);
    expect([unknown.status, unknown.body.code]).toEqual([401, 'auth.invalid_credentials']);
    expect(await actions(m.id)).toContain('platform.auth.account_locked');
    await drain();
    expect(mailer.sent.filter((s) => s.to === m.email).map((s) => s.subject)).toEqual(['UniVarse platform: your console account was locked']);
  });
});

describe('[Q10] a new browser is emailed; a known one is not', () => {
  it('the first sign-in sets a device cookie and emails; signing in again with it does not', async () => {
    const m = await member('SUPPORT');
    const first = await signIn(m, 0);
    const device = first.res.cookies['__Host-uv_console_dev'];
    expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await drain();
    expect(mailer.sent.filter((s) => s.to === m.email).map((s) => s.subject)).toEqual(['UniVarse platform: new sign-in to the console']);
    mailer.sent.length = 0;
    const second = await signIn(m, 1, `__Host-uv_console_dev=${device ?? ''}`);
    expect(second.res.cookies['__Host-uv_console_dev']).toBeUndefined();
    await drain();
    expect(mailer.sent.filter((s) => s.to === m.email)).toEqual([]);
  });
});

describe('[Q11, Q12, Q13] staff: OWNER only, with a step-up; 404 for everyone else', () => {
  it('a member without the permission gets 404, the same as an unknown route', async () => {
    const support = await member('SUPPORT');
    const { cookie } = await signIn(support);
    const refused = await call('POST', '/staff', { cookie, body: { email: uniqueEmail('x'), displayName: 'Someone', role: 'SUPPORT' } });
    const unknown = await call('GET', '/no-such-route', { cookie });
    expect([refused.status, refused.body.code]).toEqual([404, 'resource.not_found']);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'resource.not_found']);
    expect((await call('GET', '/staff', { cookie })).status).toBe(404);
  });

  it('an OWNER needs a fresh step-up to invite; the invitee gets an activation code by email', async () => {
    const owner = await member('OWNER');
    let { cookie } = await signIn(owner, 0);
    const email = uniqueEmail('invitee');
    const body = { email, displayName: 'Invited Member', role: 'FINANCE' };
    expect((await call('POST', '/staff', { cookie, body })).body.code).toBe('auth.step_up_required');
    expect((await call('POST', '/me/step-up', { cookie, body: { code: '000000' } })).status).toBe(401);
    cookie = await steppedUp(owner, cookie, 1);
    const invited = await call('POST', '/staff', { cookie, body });
    expect([invited.status, invited.body.role, invited.body.isActive, invited.body.mfaEnrolled]).toEqual([201, 'FINANCE', true, false]);
    expect((await call('POST', '/staff', { cookie, body })).body.code).toBe('staff.email_taken');
    await drain();
    const mail = mailer.sent.find((s) => s.to === email);
    expect(mail?.text).toMatch(/activation code is \d{6}/);
    // Sent mail keeps no body: it held a code.
    expect((await db.platformMailOutbox.findMany({ where: { toAddress: email } })).map((r) => [r.status, r.body])).toEqual([['SENT', '']]);
    expect(await actions(owner.id)).toContain('platform.staff.invited');
  });

  it('deactivating a member ends their sessions at once; they can\'t sign in; reinstating sends a fresh activation', async () => {
    const owner = await member('OWNER');
    const target = await member('SUPPORT');
    const targetSession = await signIn(target, 0);
    const ownerCookie = await steppedUp(owner, (await signIn(owner, 0)).cookie, 1);
    const off = await call('POST', `/staff/${target.id}/deactivate`, { cookie: ownerCookie });
    expect([off.status, off.body.isActive]).toEqual([200, false]);
    expect((await call('GET', '/me', { cookie: targetSession.cookie })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: target.email, password: PASSWORD } })).status).toBe(401);
    const back = await call('POST', `/staff/${target.id}/reinstate`, { cookie: ownerCookie });
    expect([back.body.isActive, back.body.mfaEnrolled]).toEqual([true, false]);
    // Reinstated means activating again: no password, no factor.
    expect((await db.platformUser.findUniqueOrThrow({ where: { id: target.id } })).passwordHash).toBeNull();
  });

  it('nobody changes their own role or access', async () => {
    const owner = await member('OWNER');
    const cookie = await steppedUp(owner, (await signIn(owner, 0)).cookie, 1);
    expect((await call('POST', `/staff/${owner.id}/deactivate`, { cookie })).body.code).toBe('staff.own_account');
    expect((await call('POST', `/staff/${owner.id}/role`, { cookie, body: { role: 'SUPPORT' } })).body.code).toBe('staff.own_account');
  });

  it('a role change and an MFA reset take effect, and the member is told', async () => {
    const owner = await member('OWNER');
    const target = await member('SUPPORT');
    const targetSession = await signIn(target, 0);
    const cookie = await steppedUp(owner, (await signIn(owner, 0)).cookie, 1);
    await drain(); // the sign-ins' new-browser notices
    mailer.sent.length = 0;
    expect((await call('POST', `/staff/${target.id}/role`, { cookie, body: { role: 'READ_ONLY' } })).body.role).toBe('READ_ONLY');
    expect((await call('GET', '/me', { cookie: targetSession.cookie })).body.role).toBe('READ_ONLY');
    const reset = await call('POST', `/staff/${target.id}/mfa-reset`, { cookie });
    expect(reset.body.mfaEnrolled).toBe(false);
    expect((await call('GET', '/me', { cookie: targetSession.cookie })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: target.email, password: PASSWORD } })).body).toEqual({ next: 'enrol' });
    await drain();
    expect(mailer.sent.filter((s) => s.to === target.email).map((s) => s.subject)).toEqual([
      'UniVarse platform: your console role changed',
      'UniVarse platform: your two-factor sign-in was reset',
    ]);
  });
});

describe('[Q7, Q11] recovery codes', () => {
  it('a recovery code signs in once, the member is emailed; regenerating needs a step-up and ends other sessions', async () => {
    const m = await member('SUPPORT');
    const other = await signIn(m, 0);
    await db.platformMfaFactor.updateMany({ where: { userId: m.id }, data: { lastUsedStep: null } }); // a second sign-in in this time step
    const { cookie } = await signIn(m, 0);
    expect((await call('POST', '/me/mfa/recovery-codes', { cookie })).body.code).toBe('auth.step_up_required');
    const stepped = await steppedUp(m, cookie, 1);
    const codes = (await call('POST', '/me/mfa/recovery-codes', { cookie: stepped })).body.recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect((await call('GET', '/me', { cookie: other.cookie })).status).toBe(401);
    expect((await call('GET', '/me', { cookie: stepped })).status).toBe(200);

    const login = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    const challenge = `__Host-uv_console_mfa=${login.cookies['__Host-uv_console_mfa'] ?? ''}`;
    expect((await call('POST', '/auth/mfa', { cookie: challenge, body: { recoveryCode: codes[0] } })).status).toBe(200);
    const reuse = await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } });
    expect((await call('POST', '/auth/mfa', { cookie: `__Host-uv_console_mfa=${reuse.cookies['__Host-uv_console_mfa'] ?? ''}`, body: { recoveryCode: codes[0] } })).status).toBe(401);
    await drain();
    expect(mailer.sent.some((s) => s.to === m.email && s.subject.includes('a recovery code was used to sign in'))).toBe(true);
  });
});

describe('[Q6] password reset', () => {
  it('a code and a new password end every session; TOTP is still needed to sign in', async () => {
    const m = await member('SUPPORT');
    const { cookie } = await signIn(m, 0);
    expect((await call('POST', '/auth/password-reset/request', { body: { email: m.email } })).status).toBe(202);
    expect((await call('POST', '/auth/password-reset/request', { body: { email: uniqueEmail('nobody') } })).status).toBe(202);
    await drain();
    const code = /code is (\d{6})/.exec(mailer.sent.find((s) => s.to === m.email && s.subject.endsWith('your password reset code'))?.text ?? '')?.[1] ?? '';
    expect(code).toMatch(/^\d{6}$/);
    const next = 'Another-Long-Passphrase-42';
    expect((await call('POST', '/auth/password-reset/confirm', { body: { email: m.email, code, password: next } })).status).toBe(204);
    expect((await call('GET', '/me', { cookie })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: m.email, password: next } })).body).toEqual({ next: 'mfa' });
  });
});

describe('[Q5] the first OWNER, only once', () => {
  it('refuses while any OWNER exists, naming the way forward', async () => {
    await member('OWNER');
    const outcome = await createFirstOwner(db, creds, { email: uniqueEmail('second-owner'), displayName: 'Second Owner' });
    expect(outcome).toEqual({ ok: false, problem: expect.stringMatching(/an OWNER already exists/) as string });
  });
});

describe('[CSRF, Q15] writes come from the console; audit holds ids, never an email', () => {
  it('a write without same-origin metadata is refused', async () => {
    expect((await call('POST', '/auth/login', { body: { email: uniqueEmail('x'), password: PASSWORD }, csrf: false })).body.code).toBe('request.csrf_rejected');
  });

  it('no audit metadata written by these tests holds an email address', async () => {
    const rows = await db.platformAuditEvent.findMany({ where: { action: { startsWith: 'platform.' } }, orderBy: { seq: 'desc' }, take: 500 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => JSON.stringify(r.metadata).includes('@')).map((r) => r.action)).toEqual([]);
  });
});
