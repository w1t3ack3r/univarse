/**
 * Spec 0032: changing a member's address, against the real platform database, as the console role, through the platform
 * API's own HTTP stack. The database is shared, so every member here has an address of its own.
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
import { PlatformContact } from './contact.service.js';
import { PlatformCredentials } from './credentials.js';
import { PlatformMailRelay } from './mail.js';
import { correctOwnerEmail } from './owner.js';
import { PlatformSessions } from './sessions.js';

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
const ids = new Set<string>();

beforeAll(async () => {
  app = await createPlatformApp(platformTestConfig({ CONSOLE_ALLOWLIST: '127.0.0.0/8' }), { mailer });
  db = app.get(CONSOLE_DB);
  creds = app.get(PlatformCredentials);
});
afterAll(async () => {
  const id = { in: [...ids] };
  await db.platformSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: 'test_retired' } });
  await db.platformUser.updateMany({ where: { id }, data: { role: 'READ_ONLY', isActive: false } });
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

const address = (tag: string) => `${tag}-${randomBytes(6).toString('hex')}@staff.test`;
const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

interface Member {
  id: string;
  email: string;
  secret: string;
}

async function member(role: 'OWNER' | 'SUPPORT' = 'SUPPORT', opts: { activated?: boolean } = {}): Promise<Member> {
  const email = address(role.toLowerCase());
  const activated = opts.activated !== false;
  const { id } = await db.platformUser.create({ data: { email, displayName: `Test ${role}`, role, emailVerifiedAt: activated ? new Date() : null, passwordHash: activated ? await hashPassword(PASSWORD) : null }, select: { id: true } });
  ids.add(id);
  let secret = '';
  if (activated) {
    await db.$transaction(async (tx) => {
      secret = (await creds.beginFactor(tx, { id, email })).secret;
      expect(await creds.confirmFactor(tx, id, totp(secret, -1))).toBe(true);
    });
  }
  return { id, email, secret };
}

/** A full session, made directly: a TOTP step works once, and these tests need several sessions. */
async function session(m: Member): Promise<string> {
  const { token } = await db.$transaction((tx) => app.get(PlatformSessions).create(tx, m.id, { ip, userAgent: 'test' }, { mfaAt: new Date(), restricted: false }));
  return `__Host-uv_console_sid=${token}`;
}

async function steppedUp(m: Member, cookie: string): Promise<string> {
  const r = await call('POST', '/me/step-up', { cookie, body: { code: totp(m.secret) } });
  expect(r.status).toBe(204);
  return `__Host-uv_console_sid=${r.cookies['__Host-uv_console_sid'] ?? ''}`;
}

const drain = () => app.get(PlatformMailRelay).drain();
const mailTo = async (to: string) => {
  await drain();
  return mailer.sent.filter((m) => m.to === to);
};
const codeIn = (mail: OutboundEmail | undefined) => /\b(\d{6})\b/.exec(mail?.text ?? '')?.[1] ?? '';
const undoCodeIn = (mail: OutboundEmail | undefined) => /undo code is ([A-Z2-7-]+)/.exec(mail?.text ?? '')?.[1] ?? '';
const memberRow = (id: string) => db.platformUser.findUniqueOrThrow({ where: { id } });
const memberAudit = (id: string) => db.platformAuditEvent.findMany({ where: { metadata: { path: ['memberId'], equals: id } }, orderBy: { seq: 'asc' } });
const wrongCode = (right: string) => (right === '000000' ? '000001' : '000000');

/** A member's own change, up to the code in the mail. */
async function requested(m: Member, to = address('new')): Promise<{ cookie: string; to: string; code: string }> {
  const cookie = await steppedUp(m, await session(m));
  expect((await call('POST', '/me/email', { cookie, body: { email: to } })).status).toBe(202);
  return { cookie, to, code: codeIn((await mailTo(to))[0]) };
}

describe('[Q2] a member’s own change', () => {
  it('without a step-up it is refused, and nothing changes', async () => {
    const m = await member();
    const r = await call('POST', '/me/email', { cookie: await session(m), body: { email: address('new') } });
    expect(r.body.code).toBe('auth.step_up_required');
    expect((await memberRow(m.id)).email).toBe(m.email);
  });

  it('nothing changes until the code; the old address still signs in', async () => {
    const m = await member();
    const { cookie, to, code } = await requested(m);
    expect(code).toMatch(/^\d{6}$/);
    expect((await memberRow(m.id)).email).toBe(m.email);
    expect((await call('GET', '/me/email', { cookie })).body).toMatchObject({ pending: { address: to } });
    expect((await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } })).status).toBe(200);
  });

  it('refuses the address already on the account', async () => {
    const m = await member();
    const cookie = await steppedUp(m, await session(m));
    expect((await call('POST', '/me/email', { cookie, body: { email: m.email } })).body.code).toBe('contact.same_address');
  });

  it('[Q8] offers no way to mark the old address wrong: the field is refused', async () => {
    const m = await member();
    const cookie = await steppedUp(m, await session(m));
    expect((await call('POST', '/me/email', { cookie, body: { email: address('new'), oldAddressWrong: true } })).status).toBe(400);
  });
});

describe('[Q2, Q3] the code', () => {
  it('is single use', async () => {
    const m = await member();
    const { cookie, code } = await requested(m);
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).status).toBe(204);
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).body.code).toBe('contact.code_invalid');
  });

  it('five wrong attempts spend it, even with the right code after', async () => {
    const m = await member();
    const { cookie, code } = await requested(m);
    for (let i = 0; i < 5; i += 1) expect((await call('POST', '/me/email/confirm', { cookie, body: { code: wrongCode(code) } })).body.code).toBe('contact.code_invalid');
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).body.code).toBe('contact.code_invalid');
    expect((await memberRow(m.id)).email).toBe(m.email);
  });

  it('expires', async () => {
    const m = await member();
    const to = address('late');
    await db.platformContactChange.create({ data: { userId: m.id, kind: 'SELF', newAddress: to, codeHash: creds.contactHash(m.id, to, '123456'), expiresAt: new Date(Date.now() - 1000) } });
    const cookie = await session(m);
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code: '123456' } })).body.code).toBe('contact.code_invalid');
    expect((await memberRow(m.id)).email).toBe(m.email);
  });

  it('a new request replaces the old one: the first code no longer works', async () => {
    const m = await member();
    const first = await requested(m);
    const to = address('second');
    expect((await call('POST', '/me/email', { cookie: first.cookie, body: { email: to } })).status).toBe(202);
    expect((await call('POST', '/me/email/confirm', { cookie: first.cookie, body: { code: first.code } })).body.code).toBe('contact.code_invalid');
    const second = codeIn((await mailTo(to))[0]);
    expect((await call('POST', '/me/email/confirm', { cookie: first.cookie, body: { code: second } })).status).toBe(204);
    expect((await memberRow(m.id)).email).toBe(to);
  });

  it('three requests an hour per account, then 429', async () => {
    const m = await member();
    const cookie = await steppedUp(m, await session(m));
    for (let i = 0; i < 3; i += 1) expect((await call('POST', '/me/email', { cookie, body: { email: address('n') } })).status).toBe(202);
    expect((await call('POST', '/me/email', { cookie, body: { email: address('n') } })).body.code).toBe('contact.too_many');
  });

  it('three requests an hour per new address, across accounts', async () => {
    const to = address('shared');
    for (let i = 0; i < 3; i += 1) {
      const m = await member();
      const cookie = await steppedUp(m, await session(m));
      expect((await call('POST', '/me/email', { cookie, body: { email: to } })).status).toBe(202);
    }
    const m = await member();
    const cookie = await steppedUp(m, await session(m));
    expect((await call('POST', '/me/email', { cookie, body: { email: to } })).body.code).toBe('contact.too_many');
  });
});

describe('[Q4] no enumeration', () => {
  it('a taken address answers exactly as a free one; it gets a notice, not a code; confirming fails like a wrong code', async () => {
    const [a, b, taken] = [await member(), await member(), await member()];
    const free = await call('POST', '/me/email', { cookie: await steppedUp(a, await session(a)), body: { email: address('free') } });
    const cookie = await steppedUp(b, await session(b));
    const answered = await call('POST', '/me/email', { cookie, body: { email: taken.email } });
    expect([answered.status, answered.body]).toEqual([free.status, free.body]);
    const [notice] = await mailTo(taken.email);
    expect(notice?.subject).toContain('someone tried to use this address');
    expect(notice?.text).not.toMatch(/\b\d{6}\b/);
    for (const code of ['000000', '123456']) expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).body.code).toBe('contact.code_invalid');
    expect((await memberRow(b.id)).email).toBe(b.email);
  });
});

describe('[Q5, Q6, Q14] confirming', () => {
  it('moves the address, ends the other sessions, keeps this one, tells the old address, and signs in with the new one', async () => {
    const m = await member();
    const other = await session(m);
    const { cookie, to, code } = await requested(m);
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).status).toBe(204);

    const row = await memberRow(m.id);
    expect(row.email).toBe(to);
    expect(row.emailVerifiedAt).not.toBeNull();
    expect((await call('GET', '/me', { cookie })).body.email).toBe(to);
    expect((await call('GET', '/me', { cookie: other })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: to, password: PASSWORD } })).status).toBe(200);
    expect((await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } })).status).toBe(401);

    const [told] = await mailTo(m.email);
    expect(told?.text).toMatch(/undo code is [A-Z2-7-]+/);
    expect(told?.text).not.toContain(to); // masked: the old address doesn't learn the new one (Q6)
    expect((await memberAudit(m.id)).map((e) => e.action)).toEqual(['platform.contact.change_requested', 'platform.contact.changed']);
  });

  it('a reset code sent to the old address doesn’t outlive it', async () => {
    const m = await member();
    const { cookie, to, code } = await requested(m);
    await call('POST', '/auth/password-reset/request', { body: { email: m.email } });
    const reset = codeIn((await mailTo(m.email)).find((x) => x.subject.includes('reset')));
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).status).toBe(204);
    expect((await call('POST', '/auth/password-reset/confirm', { body: { email: to, code: reset, password: 'Another-Long-Secret-77' } })).body.code).toBe('auth.reset_invalid');
  });

  it('a race for one address leaves exactly one winner', async () => {
    const to = address('race');
    const [a, b] = [await member(), await member()];
    const ra = await requested(a, to);
    mailer.sent.length = 0;
    const cb = await steppedUp(b, await session(b));
    await call('POST', '/me/email', { cookie: cb, body: { email: to } });
    const bCode = codeIn((await mailTo(to))[0]);
    const answers = await Promise.all([call('POST', '/me/email/confirm', { cookie: ra.cookie, body: { code: ra.code } }), call('POST', '/me/email/confirm', { cookie: cb, body: { code: bCode } })]);
    expect(answers.map((r) => r.status).sort()).toEqual([204, 400]);
    expect(await db.platformUser.count({ where: { email: to } })).toBe(1);
  });
});

describe('[Q6] undo', () => {
  async function changed(m: Member, to = address('new')) {
    const { cookie, code } = await requested(m, to);
    expect((await call('POST', '/me/email/confirm', { cookie, body: { code } })).status).toBe(204);
    const told = (await mailTo(m.email)).at(-1);
    return { cookie, to, undo: undoCodeIn(told) };
  }

  it('restores the address, ends every session, and the old password no longer signs in until a reset', async () => {
    const m = await member();
    const { cookie, to, undo } = await changed(m);
    await call('POST', '/auth/password-reset/request', { body: { email: to } });
    const stolen = codeIn((await mailTo(to)).find((x) => x.subject.includes('reset')));

    expect((await call('POST', '/auth/contact-change/undo', { body: { email: m.email, code: undo } })).status).toBe(204);
    expect((await memberRow(m.id)).email).toBe(m.email);
    expect((await call('GET', '/me', { cookie })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: m.email, password: PASSWORD } })).status).toBe(401);
    // A reset code the intruder asked for is dead too.
    expect((await call('POST', '/auth/password-reset/confirm', { body: { email: m.email, code: stolen, password: 'Another-Long-Secret-77' } })).body.code).toBe('auth.reset_invalid');

    await call('POST', '/auth/password-reset/request', { body: { email: m.email } });
    const reset = codeIn((await mailTo(m.email)).filter((x) => x.subject.includes('reset')).at(-1));
    expect((await call('POST', '/auth/password-reset/confirm', { body: { email: m.email, code: reset, password: 'Another-Long-Secret-77' } })).status).toBe(204);
    expect((await call('POST', '/auth/login', { body: { email: m.email, password: 'Another-Long-Secret-77' } })).status).toBe(200);
    expect((await db.platformAuditEvent.findMany({ where: { metadata: { path: ['memberId'], equals: m.id }, action: 'platform.contact.undone' } })).length).toBe(1);
  });

  it('fails after 72 hours, on a wrong code, and after five wrong tries', async () => {
    const m = await member();
    const { undo } = await changed(m);
    for (let i = 0; i < 5; i += 1) expect((await call('POST', '/auth/contact-change/undo', { body: { email: m.email, code: 'AAAAA-AAAAA' } })).body.code).toBe('contact.undo_invalid');
    expect((await call('POST', '/auth/contact-change/undo', { body: { email: m.email, code: undo } })).body.code).toBe('contact.undo_invalid');

    const n = await member();
    const late = await changed(n);
    await db.platformContactChange.updateMany({ where: { userId: n.id }, data: { undoUntil: new Date(Date.now() - 1000) } });
    expect((await call('POST', '/auth/contact-change/undo', { body: { email: n.email, code: late.undo } })).body.code).toBe('contact.undo_invalid');
    expect((await memberRow(n.id)).email).toBe(late.to);
  });

  it('an intruder who moved the account twice can’t use their own undo to close the owner’s', async () => {
    const m = await member();
    const first = await changed(m); // m.email → first.to: the owner's undo
    const step = await session(m);
    const cookie = (await call('POST', '/me/step-up', { cookie: step, body: { code: totp(m.secret, 1) } })).cookies['__Host-uv_console_sid'] ?? '';
    const to = address('third');
    await call('POST', '/me/email', { cookie: `__Host-uv_console_sid=${cookie}`, body: { email: to } });
    const code = codeIn((await mailTo(to))[0]);
    await call('POST', '/me/email/confirm', { cookie: `__Host-uv_console_sid=${cookie}`, body: { code } });
    const second = undoCodeIn((await mailTo(first.to)).at(-1));

    expect((await call('POST', '/auth/contact-change/undo', { body: { email: first.to, code: second } })).status).toBe(204);
    expect((await call('POST', '/auth/contact-change/undo', { body: { email: m.email, code: first.undo } })).status).toBe(204);
    expect((await memberRow(m.id)).email).toBe(m.email);
  });

  it('the old address is held during the window: nobody else can take it', async () => {
    const [m, other] = [await member(), await member()];
    await changed(m);
    const owner = await member('OWNER');
    const cookie = await steppedUp(owner, await session(owner));
    expect((await call('POST', '/staff', { cookie, body: { email: m.email, displayName: 'Someone Else', role: 'SUPPORT' } })).body.code).toBe('staff.email_taken');
    expect((await call('POST', `/staff/${other.id}/email`, { cookie, body: { email: m.email, oldAddressWrong: false } })).body.code).toBe('staff.email_taken');

    mailer.sent.length = 0;
    const theirs = await steppedUp(other, await session(other));
    expect((await call('POST', '/me/email', { cookie: theirs, body: { email: m.email } })).status).toBe(202);
    expect((await mailTo(m.email))[0]?.subject).toContain('someone tried to use this address');
  });
});

describe('[Q7, Q8, Q9] an administrator’s correction', () => {
  const correct = async (actor: Member, target: string, body: unknown) => call('POST', `/staff/${target}/email`, { cookie: await steppedUp(actor, await session(actor)), body });

  it('an administrator alone can’t finish it: it takes the person’s password and the code', async () => {
    const [owner, m] = [await member('OWNER'), await member()];
    const to = address('fixed');
    expect((await correct(owner, m.id, { email: to, oldAddressWrong: false })).status).toBe(202);
    const code = codeIn((await mailTo(to))[0]);
    expect((await memberRow(m.id)).email).toBe(m.email);

    expect((await call('POST', '/auth/contact-change/confirm', { body: { email: to, code, password: 'Not-The-Password-1234' } })).body.code).toBe('contact.code_invalid');
    expect((await call('POST', '/auth/contact-change/confirm', { body: { email: to, code: wrongCode(code), password: PASSWORD } })).body.code).toBe('contact.code_invalid');
    expect((await memberRow(m.id)).email).toBe(m.email);
    expect((await call('POST', '/auth/contact-change/confirm', { body: { email: to, code, password: PASSWORD } })).status).toBe(204);
    expect((await memberRow(m.id)).email).toBe(to);
    expect((await mailTo(m.email)).at(-1)?.text).toMatch(/undo code is/);
  });

  it('a member’s own pending change can’t be finished on the signed-out page', async () => {
    const m = await member();
    const { to, code } = await requested(m);
    expect((await call('POST', '/auth/contact-change/confirm', { body: { email: to, code, password: PASSWORD } })).body.code).toBe('contact.code_invalid');
  });

  it('marking the old address wrong sends nothing to it and leaves no undo', async () => {
    const [owner, m] = [await member('OWNER'), await member()];
    const to = address('fixed');
    await correct(owner, m.id, { email: to, oldAddressWrong: true });
    const code = codeIn((await mailTo(to))[0]);
    expect((await call('POST', '/auth/contact-change/confirm', { body: { email: to, code, password: PASSWORD } })).status).toBe(204);
    expect(await mailTo(m.email)).toEqual([]);
    expect((await mailTo(to)).at(-1)?.subject).toContain('this is now your address');
    const row = await db.platformContactChange.findFirstOrThrow({ where: { userId: m.id } });
    expect([row.oldAddressWrong, row.undoHash, row.undoUntil]).toEqual([true, null, null]);
  });

  it('not activated yet: the address changes at once, the old activation code dies, and activation proves the new one', async () => {
    const [owner, m] = [await member('OWNER'), await member('SUPPORT', { activated: false })];
    const old = await db.$transaction((tx) => creds.issueCode(tx, m.id, 'ACTIVATION'));
    const to = address('fixed');
    expect((await correct(owner, m.id, { email: to, oldAddressWrong: false })).status).toBe(202);
    expect((await memberRow(m.id)).email).toBe(to);
    expect((await call('POST', '/auth/activate', { body: { email: to, code: old, password: PASSWORD } })).body.code).toBe('auth.activation_invalid');
    const code = codeIn((await mailTo(to))[0]);
    expect((await call('POST', '/auth/activate', { body: { email: to, code, password: PASSWORD } })).status).toBe(200);
    expect((await memberRow(m.id)).emailVerifiedAt).not.toBeNull();
  });

  it('needs the permission, a step-up, and a real member; never one’s own', async () => {
    const [owner, support, m] = [await member('OWNER'), await member(), await member()];
    const body = { email: address('x'), oldAddressWrong: false };
    expect((await call('POST', `/staff/${m.id}/email`, { cookie: await session(owner), body })).body.code).toBe('auth.step_up_required');
    expect((await correct(support, m.id, body)).status).toBe(404); // out of scope reads as absent
    const cookie = await steppedUp(owner, await session(owner));
    expect((await call('POST', '/staff/019a0000-0000-7000-8000-000000000001/email', { cookie, body })).status).toBe(404);
    expect((await call('POST', `/staff/${owner.id}/email`, { cookie, body })).body.code).toBe('staff.own_account');
    expect((await call('POST', `/staff/${m.id}/email`, { cookie, body: { email: support.email, oldAddressWrong: false } })).body.code).toBe('staff.email_taken');
  });
});

describe('[Q10] the owner’s command', () => {
  it('sends a code to the new address, finished with the password, audited with no actor', async () => {
    const owner = await member('OWNER');
    const to = address('cmd');
    expect(await correctOwnerEmail(db, creds, { email: owner.email, newEmail: to, oldAddressWrong: true })).toEqual({ ok: true, memberId: owner.id });
    const code = codeIn((await mailTo(to))[0]);
    expect((await call('POST', '/auth/contact-change/confirm', { body: { email: to, code, password: PASSWORD } })).status).toBe(204);
    expect((await memberRow(owner.id)).email).toBe(to);
    expect((await memberAudit(owner.id)).map((e) => e.actorId)).toEqual([null, null]);
    expect(await mailTo(owner.email)).toEqual([]);
  });

  it('is only for an active OWNER, and refuses a taken address', async () => {
    const [owner, m] = [await member('OWNER'), await member()];
    expect((await correctOwnerEmail(db, creds, { email: m.email, newEmail: address('x'), oldAddressWrong: false })).ok).toBe(false);
    expect((await correctOwnerEmail(db, creds, { email: owner.email, newEmail: m.email, oldAddressWrong: false })).ok).toBe(false);
  });
});

describe('[Q12] no address kept or recorded', () => {
  it('no audit row holds an address', async () => {
    const m = await member();
    const { cookie, to, code } = await requested(m);
    await call('POST', '/me/email/confirm', { cookie, body: { code } });
    const text = JSON.stringify((await memberAudit(m.id)).map((e) => e.metadata));
    expect(text).not.toContain('@');
    expect(text).not.toContain(to);
  });

  it('blanks a finished change after its window, and only then', async () => {
    const m = await member();
    const { cookie, code } = await requested(m);
    await call('POST', '/me/email/confirm', { cookie, body: { code } });
    const contact = app.get(PlatformContact);
    await contact.blank();
    expect((await db.platformContactChange.findFirstOrThrow({ where: { userId: m.id } })).oldAddress).toBe(m.email);

    await contact.blank(new Date(Date.now() + 73 * 3_600_000));
    const row = await db.platformContactChange.findFirstOrThrow({ where: { userId: m.id } });
    expect([row.newAddress, row.oldAddress, row.undoHash, row.status]).toEqual([null, null, null, 'CONFIRMED']);
    expect(row.blankedAt).not.toBeNull();
  });
});
