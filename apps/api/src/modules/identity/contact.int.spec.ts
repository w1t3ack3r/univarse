/**
 * Spec 0032 PR B: changing a user's address, the institutions' side, through the real API, against the real shard.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running.
 */
import { randomBytes } from 'node:crypto';
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, HOSTS, PASSWORD, randomIp, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { ContactBlanker } from './contact-blanker.js';

let h: Harness;
const D = HOSTS.demo;
const P = HOSTS.poly;
const db = () => forTenant(h.shard, h.tenants.demo);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const cookies = (res: InjectResult): string[] => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
};
const sessionOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
const challengeOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_mfa=') && c.length > 20)!;
const address = (tag: string) => `${tag}-${randomBytes(6).toString('hex')}@contact.test`;
const post = (url: string, o: { cookie?: string; body?: unknown }) => h.call('POST', D, url, { ip: randomIp(), ...o });
const account = (id: string) => db().userAccount.findUniqueOrThrow({ where: { id } });
const NEW_PASSWORD = 'Another-Long-Secret-77';

/** A student with a session that has stepped up: no factor, so the password alone. */
async function student() {
  const u = await h.makeUser('demo', { role: 'STUDENT', email: address('old') });
  const login = await h.login(D, u.username);
  const up = await post('/api/v1/auth/step-up', { cookie: sessionOf(login), body: { password: PASSWORD } });
  expect(up.statusCode).toBe(200);
  return { ...u, email: u.email!, cookie: sessionOf(up) };
}

/** An administrator with a session that has stepped up. */
async function admin(role = 'INSTITUTION_ADMIN') {
  const u = await h.makeUser('demo', { role, email: address('admin') });
  const secret = await enrolTestTotp(h.shard, h.tenants.demo, u.id);
  const login = await h.login(D, u.username);
  const verified = await post('/api/v1/auth/mfa/verify', { cookie: challengeOf(login), body: { code: totpCode(secret) } });
  expect(verified.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants.demo, u.id);
  const up = await post('/api/v1/auth/step-up', { cookie: sessionOf(verified), body: { password: PASSWORD, code: totpCode(secret) } });
  expect(up.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants.demo, u.id);
  return { ...u, cookie: sessionOf(up) };
}

async function mailCode(to: string): Promise<string> {
  const mail = await h.waitForMail(to, /confirm your new address|being corrected/, 0).catch(() => h.waitForMail(to, /./, 0));
  return /\b(\d{6})\b/.exec(mail.text)?.[1] ?? '';
}

async function requested(u: { cookie: string }, to = address('new')) {
  expect((await post('/api/v1/auth/email', { cookie: u.cookie, body: { email: to } })).statusCode).toBe(202);
  await h.deliver();
  return { to, code: await mailCode(to) };
}

async function changed(u: { id: string; email: string; cookie: string }, to = address('new')) {
  const { code } = await requested(u, to);
  expect((await post('/api/v1/auth/email/confirm', { cookie: u.cookie, body: { code } })).statusCode).toBe(204);
  await h.deliver();
  const told = await h.waitForMail(u.email, /your address was changed/, 0);
  return { to, undo: /undo code is ([A-Z2-7-]+)/.exec(told.text)?.[1] ?? '', told };
}

describe('[0032 Q2] a user’s own change', () => {
  it('without a fresh step-up it is refused', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT', email: address('old') });
    const r = await post('/api/v1/auth/email', { cookie: sessionOf(await h.login(D, u.username)), body: { email: address('new') } });
    expect(r.json().code).toBe('auth.step_up_required');
  });

  it('nothing changes until the code; the row holds no address in clear', async () => {
    const u = await student();
    const { to } = await requested(u);
    expect((await account(u.id)).email).toBe(u.email);
    const row = await db().contactChange.findFirstOrThrow({ where: { userId: u.id } });
    expect(JSON.stringify({ a: row.newAddressEnc })).not.toContain(to);
    const status = await h.call('GET', D, '/api/v1/auth/email', { cookie: u.cookie });
    expect(status.json()).toMatchObject({ address: u.email, pending: { address: to } });
  });

  it('[Q8] offers no way to mark the old address wrong', async () => {
    const u = await student();
    expect((await post('/api/v1/auth/email', { cookie: u.cookie, body: { email: address('new'), oldAddressWrong: true } })).statusCode).toBe(400);
  });

  it('five wrong attempts spend the code; three requests an hour, then 429', async () => {
    const u = await student();
    const { code } = await requested(u);
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await post('/api/v1/auth/email/confirm', { cookie: u.cookie, body: { code: wrong } })).json().code).toBe('contact.code_invalid');
    expect((await post('/api/v1/auth/email/confirm', { cookie: u.cookie, body: { code } })).json().code).toBe('contact.code_invalid');
    for (let i = 0; i < 2; i += 1) expect((await post('/api/v1/auth/email', { cookie: u.cookie, body: { email: address('n') } })).statusCode).toBe(202);
    expect((await post('/api/v1/auth/email', { cookie: u.cookie, body: { email: address('n') } })).json().code).toBe('contact.too_many');
  });

  it('three requests an hour per new address, across accounts', async () => {
    const to = address('shared');
    for (let i = 0; i < 3; i += 1) expect((await post('/api/v1/auth/email', { cookie: (await student()).cookie, body: { email: to } })).statusCode).toBe(202);
    expect((await post('/api/v1/auth/email', { cookie: (await student()).cookie, body: { email: to } })).json().code).toBe('contact.too_many');
  });
});

describe('[Q4] no enumeration', () => {
  it('a taken address answers as a free one, gets a notice and no code, and confirming fails like a wrong code', async () => {
    const [a, b, taken] = [await student(), await student(), await student()];
    const free = await post('/api/v1/auth/email', { cookie: a.cookie, body: { email: address('free') } });
    const answered = await post('/api/v1/auth/email', { cookie: b.cookie, body: { email: taken.email } });
    expect([answered.statusCode, answered.json()]).toEqual([free.statusCode, free.json()]);
    await h.deliver();
    const notice = await h.waitForMail(taken.email, /someone tried to use this address/, 0);
    expect(notice.text).not.toMatch(/\b\d{6}\b/);
    expect((await post('/api/v1/auth/email/confirm', { cookie: b.cookie, body: { code: '123456' } })).json().code).toBe('contact.code_invalid');
    expect((await account(b.id)).email).toBe(b.email);
  });
});

describe('[Q5, Q6] confirming and undoing', () => {
  it('moves the address, ends the other sessions, keeps this one, and tells the old address with a masked new one', async () => {
    const u = await student();
    const other = sessionOf(await h.login(D, u.username));
    const { to, told } = await changed(u);
    const row = await account(u.id);
    expect([row.email, row.emailVerifiedAt === null]).toEqual([to, false]);
    expect((await h.call('GET', D, '/api/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(200);
    expect((await h.call('GET', D, '/api/v1/auth/me', { cookie: other })).statusCode).toBe(401);
    expect(told.text).not.toContain(to);
    // Q14: the username doesn't change, and the new address signs in.
    expect((await h.login(D, to)).statusCode).toBe(200);
  });

  it('two people after one address: the second finds it gone, and fails like a wrong code', async () => {
    const to = address('race');
    const [a, b] = [await student(), await student()];
    const first = await requested(a, to);
    const before = h.mailsTo(to).length;
    expect((await post('/api/v1/auth/email', { cookie: b.cookie, body: { email: to } })).statusCode).toBe(202);
    await h.deliver();
    await h.waitForMail(to, /confirm your new address/, before);
    const second = /\b(\d{6})\b/.exec(h.mailsTo(to).at(-1)?.text ?? '')?.[1] ?? '';
    expect((await post('/api/v1/auth/email/confirm', { cookie: a.cookie, body: { code: first.code } })).statusCode).toBe(204);
    const late = await post('/api/v1/auth/email/confirm', { cookie: b.cookie, body: { code: second } });
    expect([late.statusCode, late.json().code]).toEqual([400, 'contact.code_invalid']);
    expect((await account(b.id)).email).toBe(b.email);
  });

  it('a reset code sent to the old address doesn’t outlive it', async () => {
    const u = await student();
    await post('/api/v1/auth/password-reset/request', { body: { username: u.username } });
    await h.deliver();
    const reset = /\b(\d{6})\b/.exec((await h.waitForMail(u.email, /password reset code/, 0)).text)?.[1] ?? '';
    await changed(u);
    expect((await post('/api/v1/auth/password-reset/confirm', { body: { username: u.username, code: reset, password: NEW_PASSWORD } })).json().code).toBe('auth.reset_invalid');
  });

  it('an undo restores the address, ends every session, kills the old password and any reset code, until a new reset', async () => {
    const u = await student();
    const { to, undo } = await changed(u);
    await post('/api/v1/auth/password-reset/request', { body: { username: u.username } });
    await h.deliver();
    const stolen = /\b(\d{6})\b/.exec((await h.waitForMail(to, /password reset code/, 0)).text)?.[1] ?? '';

    expect((await post('/api/v1/auth/contact-change/undo', { body: { username: u.username, code: undo } })).statusCode).toBe(204);
    expect((await account(u.id)).email).toBe(u.email);
    expect((await h.call('GET', D, '/api/v1/auth/me', { cookie: u.cookie })).statusCode).toBe(401);
    expect((await post('/api/v1/auth/login', { body: { username: u.username, password: PASSWORD } })).statusCode).toBe(401);
    expect((await post('/api/v1/auth/password-reset/confirm', { body: { username: u.username, code: stolen, password: NEW_PASSWORD } })).json().code).toBe('auth.reset_invalid');

    await post('/api/v1/auth/password-reset/request', { body: { username: u.username } });
    await h.deliver();
    const count = h.mailsTo(u.email).filter((m) => /password reset code/.test(m.subject)).length;
    const reset = /\b(\d{6})\b/.exec((await h.waitForMail(u.email, /password reset code/, count - 1)).text)?.[1] ?? '';
    expect((await post('/api/v1/auth/password-reset/confirm', { body: { username: u.username, code: reset, password: NEW_PASSWORD } })).statusCode).toBe(204);
    expect((await post('/api/v1/auth/login', { body: { username: u.username, password: NEW_PASSWORD } })).statusCode).toBe(200);
  });

  it('fails on a wrong code, after five tries, and after 72 hours', async () => {
    const u = await student();
    const { undo } = await changed(u);
    for (let i = 0; i < 5; i += 1) expect((await post('/api/v1/auth/contact-change/undo', { body: { username: u.username, code: 'AAAAA-AAAAA' } })).json().code).toBe('contact.undo_invalid');
    expect((await post('/api/v1/auth/contact-change/undo', { body: { username: u.username, code: undo } })).json().code).toBe('contact.undo_invalid');

    const n = await student();
    const late = await changed(n);
    await db().contactChange.updateMany({ where: { userId: n.id }, data: { undoUntil: new Date(Date.now() - 1000) } });
    expect((await post('/api/v1/auth/contact-change/undo', { body: { username: n.username, code: late.undo } })).json().code).toBe('contact.undo_invalid');
  });

  it('someone who moved the account twice can’t use their own undo to close the owner’s', async () => {
    const u = await student();
    const first = await changed(u);
    const third = address('third');
    const { code } = await requested(u, third);
    expect((await post('/api/v1/auth/email/confirm', { cookie: u.cookie, body: { code } })).statusCode).toBe(204);
    await h.deliver();
    const second = /undo code is ([A-Z2-7-]+)/.exec((await h.waitForMail(first.to, /your address was changed/, 0)).text)?.[1] ?? '';

    expect((await post('/api/v1/auth/contact-change/undo', { body: { username: u.username, code: second } })).statusCode).toBe(204);
    expect((await post('/api/v1/auth/contact-change/undo', { body: { username: u.username, code: first.undo } })).statusCode).toBe(204);
    expect((await account(u.id)).email).toBe(u.email);
  });

  it('the old address is held: nobody else can move to it during the window', async () => {
    const [u, other] = [await student(), await student()];
    await changed(u);
    expect((await post('/api/v1/auth/email', { cookie: other.cookie, body: { email: u.email } })).statusCode).toBe(202);
    await h.deliver();
    await h.waitForMail(u.email, /someone tried to use this address/, 0);
  });

  it('an account with no address can add one: nothing to tell, nothing to undo', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT', email: null });
    const up = await post('/api/v1/auth/step-up', { cookie: sessionOf(await h.login(D, u.username)), body: { password: PASSWORD } });
    const cookie = sessionOf(up);
    const { to, code } = await requested({ cookie });
    expect((await post('/api/v1/auth/email/confirm', { cookie, body: { code } })).statusCode).toBe(204);
    expect((await account(u.id)).email).toBe(to);
    expect(await db().contactChange.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ undoHash: null, undoUntil: null, oldAddressEnc: null });
  });
});

describe('[Q7, Q8, Q9] an administrator’s correction', () => {
  const correct = (cookie: string, id: string, body: unknown) => post(`/api/v1/users/${id}/email`, { cookie, body });

  it('an administrator alone can’t finish it: it takes the person’s password and the code', async () => {
    const [a, u] = [await admin(), await student()];
    const to = address('fixed');
    expect((await correct(a.cookie, u.id, { email: to, oldAddressWrong: false })).statusCode).toBe(202);
    await h.deliver();
    const code = await mailCode(to);
    expect((await account(u.id)).email).toBe(u.email);
    expect((await post('/api/v1/auth/contact-change/confirm', { body: { username: u.username, code, password: 'Not-The-Password-1234' } })).json().code).toBe('contact.code_invalid');
    expect((await post('/api/v1/auth/contact-change/confirm', { body: { username: u.username, code: code === '000000' ? '000001' : '000000', password: PASSWORD } })).json().code).toBe('contact.code_invalid');
    expect((await post('/api/v1/auth/contact-change/confirm', { body: { username: u.username, code, password: PASSWORD } })).statusCode).toBe(204);
    expect((await account(u.id)).email).toBe(to);
    await h.deliver();
    expect((await h.waitForMail(u.email, /your address was changed/, 0)).text).toMatch(/undo code is/);
  });

  it('a user’s own pending change can’t be finished on the signed-out page', async () => {
    const u = await student();
    const { code } = await requested(u);
    expect((await post('/api/v1/auth/contact-change/confirm', { body: { username: u.username, code, password: PASSWORD } })).json().code).toBe('contact.code_invalid');
  });

  it('marking the old address wrong sends nothing to it and leaves no undo', async () => {
    const [a, u] = [await admin(), await student()];
    const to = address('fixed');
    await correct(a.cookie, u.id, { email: to, oldAddressWrong: true });
    await h.deliver();
    const code = await mailCode(to);
    expect((await post('/api/v1/auth/contact-change/confirm', { body: { username: u.username, code, password: PASSWORD } })).statusCode).toBe(204);
    await h.deliver();
    expect(h.mailsTo(u.email)).toEqual([]);
    expect(await db().contactChange.findFirstOrThrow({ where: { userId: u.id } })).toMatchObject({ oldAddressWrong: true, undoHash: null, undoUntil: null });
  });

  it('not activated yet: the address changes at once, the code goes there, and activation proves it', async () => {
    const a = await admin();
    const u = await h.makeUser('demo', { role: 'STUDENT', status: 'PENDING_ACTIVATION', email: address('typo') });
    const to = address('fixed');
    expect((await correct(a.cookie, u.id, { email: to, oldAddressWrong: false })).statusCode).toBe(202);
    expect(await account(u.id)).toMatchObject({ email: to, emailVerifiedAt: null });
    await h.deliver();
    const code = await mailCode(to);
    expect((await post('/api/v1/auth/activation/confirm', { body: { username: u.username, code, password: NEW_PASSWORD } })).statusCode).toBe(204);
    expect((await account(u.id)).emailVerifiedAt).not.toBeNull();
  });

  it('needs the permission; another institution’s user reads as absent', async () => {
    const [a, u, registrar] = [await admin(), await student(), await admin('REGISTRAR')];
    const body = { email: address('x'), oldAddressWrong: false };
    expect((await correct(registrar.cookie, u.id, body)).statusCode).toBe(403);
    const elsewhere = await h.makeUser('poly', { role: 'STUDENT', email: address('poly') });
    expect((await correct(a.cookie, elsewhere.id, body)).statusCode).toBe(404);
    expect((await correct(a.cookie, 'not-a-uuid', body)).statusCode).toBe(404);
    expect((await correct(a.cookie, a.id, body)).json().code).toBe('contact.own_account');
    expect((await correct(a.cookie, u.id, { email: a.email, oldAddressWrong: false })).json().code).toBe('contact.address_taken');
    const fresh = sessionOf(await h.login(D, u.username)); // a student holds no such permission
    expect((await correct(fresh, u.id, body)).statusCode).toBe(403);
  });

  it('the host decides the tenant: the same username on another host finds nothing', async () => {
    const u = await student();
    const r = await h.call('POST', P, '/api/v1/auth/contact-change/undo', { ip: randomIp(), body: { username: u.username, code: 'AAAAA-AAAAA' } });
    expect(r.json().code).toBe('contact.undo_invalid');
  });
});

describe('[Q12] no address kept or recorded', () => {
  it('no audit row holds an address', async () => {
    const u = await student();
    const { to } = await changed(u);
    const rows = await db().auditEvent.findMany({ where: { entityId: u.id } });
    const text = JSON.stringify(rows.map((e) => [e.before, e.after, e.action]));
    expect(rows.map((e) => e.action)).toEqual(expect.arrayContaining(['identity.email_change.requested', 'identity.email_change.confirmed']));
    expect(text).not.toContain('@');
    expect(text).not.toContain(to);
  });

  it('blanks a finished change after its window, and only then', async () => {
    const u = await student();
    await changed(u);
    const blanker = h.workerCtx.get(ContactBlanker);
    const t = { id: h.tenants.demo, shardId: (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId };
    await blanker.blankTenant(t);
    expect((await db().contactChange.findFirstOrThrow({ where: { userId: u.id } })).oldAddressEnc).not.toBeNull();
    await blanker.blankTenant(t, new Date(Date.now() + 73 * 3_600_000));
    const row = await db().contactChange.findFirstOrThrow({ where: { userId: u.id } });
    expect(row).toMatchObject({ newAddressEnc: null, oldAddressEnc: null, newAddressHash: null, oldAddressHash: null, undoHash: null, status: 'CONFIRMED' });
    expect(row.blankedAt).not.toBeNull();
  });
});
