/**
 * Spec 0001 Part S — step-up, and the MFA-management endpoints behind it (M9a–M9e).
 * Every AC ID appears in a test name. Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running.
 */
import { createHmac } from 'node:crypto';
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, HOSTS, PASSWORD, randomIp, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { base32Decode } from './totp.js';
import { sha256 } from './tokens.js';

let h: Harness;
const D = HOSTS.demo;
const db = () => forTenant(h.shard, h.tenants.demo);

const cookies = (res: InjectResult): string[] => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
};
const sessionOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
const challengeOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_mfa=') && c.length > 20)!;
const tokenOf = (cookie: string) => cookie.split('=')[1]!;
const sessionRow = (cookie: string) =>
  db().session.findUniqueOrThrow({ where: { tenantId_tokenHash: { tenantId: h.tenants.demo, tokenHash: sha256(tokenOf(cookie)) } } });

const me = (cookie: string) => h.call('GET', D, '/api/v1/auth/me', { cookie });
const stepUp = (cookie: string, body: object, o: { ip?: string } = {}) =>
  h.call('POST', D, '/api/v1/auth/step-up', { cookie, body, ...o });
const regenerate = (cookie: string) => h.call('POST', D, '/api/v1/auth/mfa/recovery-codes/regenerate', { cookie, body: {} });
const disable = (cookie: string) => h.call('POST', D, '/api/v1/auth/mfa/totp/disable', { cookie, body: {} });
const verify = (challenge: string, body: object) => h.call('POST', D, '/api/v1/auth/mfa/verify', { cookie: challenge, body });

/** Same derivation as MfaService.recoveryHash: lets a test tell WHICH set of codes is stored. */
const recoveryHash = (userId: string, code: string) =>
  createHmac('sha256', process.env.SESSION_PEPPER!)
    .update(`${userId}:recovery:${code.toUpperCase().replace(/[^A-Z2-7]/g, '')}`)
    .digest('hex');

/** A plain (non-MFA) user with a session. */
async function plainUser(role = 'STUDENT') {
  const u = await h.makeUser('demo', { role });
  return { ...u, session: sessionOf(await h.login(D, u.username)) };
}

/** Enrols through the API (so recovery codes are known); the replay guard is cleared afterwards. */
async function mfaUser(role = 'STUDENT') {
  const u = await h.makeUser('demo', { role });
  const first = sessionOf(await h.login(D, u.username));
  const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: first, body: { password: PASSWORD } });
  expect(begin.statusCode).toBe(200);
  const secret = base32Decode(begin.json().secret);
  const confirm = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: first, body: { code: totpCode(secret) } });
  expect(confirm.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants.demo, u.id);
  return { ...u, secret, session: sessionOf(confirm), recoveryCodes: confirm.json().recoveryCodes as string[] };
}

/** A further MFA-verified session (another device) for the same user. */
async function anotherSession(u: { id: string; username: string; secret: Buffer }) {
  const res = await verify(challengeOf(await h.login(D, u.username)), { code: totpCode(u.secret) });
  expect(res.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants.demo, u.id);
  return sessionOf(res);
}

/** Steps up with password + current TOTP; returns the NEW session cookie. */
async function steppedUp(u: { id: string; secret: Buffer; session: string }) {
  const res = await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret) });
  expect(res.statusCode).toBe(200);
  await resetReplayGuard(h.shard, h.tenants.demo, u.id);
  return sessionOf(res);
}

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('step-up (S1–S4, S6, S8)', () => {
  it('[S2] a non-MFA user steps up with the password alone', async () => {
    const u = await plainUser();
    const res = await stepUp(u.session, { password: PASSWORD });
    expect([res.statusCode, res.json()]).toEqual([200, { stepUp: true }]);
    expect((await sessionRow(sessionOf(res))).stepUpAt).not.toBeNull();
  });

  it('[S2] an MFA user needs password + TOTP or recovery code; never one without the other', async () => {
    const u = await mfaUser();
    const missing = await stepUp(u.session, { password: PASSWORD });
    expect([missing.statusCode, missing.json().code]).toEqual([400, 'auth.step_up_second_factor_required']);
    const wrongCode = await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret, 7) });
    expect([wrongCode.statusCode, wrongCode.json().code]).toEqual([401, 'auth.mfa_invalid']);
    const both = await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret), recoveryCode: u.recoveryCodes[0]! });
    expect(both.statusCode).toBe(400);
    expect((await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret) })).statusCode).toBe(200);
    await resetReplayGuard(h.shard, h.tenants.demo, u.id); // that step is spent (M5); the helper below logs in again
    const viaRecovery = await stepUp(await anotherSession(u), { password: PASSWORD, recoveryCode: u.recoveryCodes[0]! });
    expect(viaRecovery.statusCode).toBe(200);
  });

  it('[S2] a wrong password is refused before the second factor is looked at (nothing spent)', async () => {
    const u = await mfaUser();
    const res = await stepUp(u.session, { password: 'Wrong-Password-12345', code: totpCode(u.secret) });
    expect([res.statusCode, res.json().code]).toEqual([401, 'auth.invalid_credentials']);
    const factor = await db().mfaFactor.findFirstOrThrow({ where: { userId: u.id } });
    expect(factor.lastUsedStep).toBeNull();
    // …so the same code still works with the right password.
    expect((await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret) })).statusCode).toBe(200);
  });

  it('[S2][M8] a privileged user without a factor cannot step up with a password alone', async () => {
    // Session issued while non-privileged; a privileged role is granted afterwards.
    const u = await plainUser();
    const role = await db().role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: h.tenants.demo, key: 'INSTITUTION_ADMIN' } } });
    await db().roleAssignment.create({ data: { tenantId: h.tenants.demo, userId: u.id, roleId: role.id, scopeType: 'INSTITUTION' } });
    const res = await stepUp(u.session, { password: PASSWORD });
    expect([res.statusCode, res.json().code]).toEqual([403, 'auth.mfa_enrolment_required']);
    expect(await db().session.count({ where: { userId: u.id, stepUpAt: { not: null } } })).toBe(0);
  });

  it('[S3] step-up rotates the token: new cookie, old token revoked', async () => {
    const u = await plainUser();
    const res = await stepUp(u.session, { password: PASSWORD });
    const fresh = sessionOf(res);
    expect(fresh).not.toBe(u.session);
    expect((await me(u.session)).statusCode).toBe(401);
    expect((await me(fresh)).statusCode).toBe(200);
    expect((await sessionRow(u.session)).revokeReason).toBe('step_up');
    // The revoked token can't be stepped up again either.
    expect((await stepUp(u.session, { password: PASSWORD })).statusCode).toBe(401);
  });

  it('[S1] a fresh step-up opens @RequireStepUp() routes; after 5 minutes they answer 428 again', async () => {
    const u = await mfaUser();
    expect((await regenerate(u.session)).statusCode).toBe(428);
    const fresh = await steppedUp(u);
    expect((await regenerate(fresh)).statusCode).toBe(200);
    await db().session.updateMany({
      where: { tokenHash: sha256(tokenOf(fresh)) },
      data: { stepUpAt: new Date(Date.now() - 5 * 60_000 - 5_000) },
    });
    const late = await regenerate(fresh);
    expect([late.statusCode, late.json().code]).toEqual([428, 'auth.step_up_required']);
  });

  it('[S4] stepping up on device A does not elevate device B', async () => {
    const u = await mfaUser();
    const deviceB = await anotherSession(u);
    const deviceA = await steppedUp(u);
    expect((await regenerate(deviceB)).statusCode).toBe(428);
    expect((await regenerate(deviceA)).statusCode).toBe(200);
  });

  it('[S6] step_up_at lives only on the rotated session: never set by login or verify, never copied', async () => {
    const u = await mfaUser();
    const deviceB = await anotherSession(u);
    expect((await sessionRow(u.session)).stepUpAt).toBeNull(); // issued by enrolment confirm
    expect((await sessionRow(deviceB)).stepUpAt).toBeNull(); // issued by MFA verify
    const plain = await plainUser();
    expect((await sessionRow(plain.session)).stepUpAt).toBeNull(); // issued by login
    const fresh = await steppedUp(u);
    expect((await sessionRow(fresh)).stepUpAt).not.toBeNull();
    expect((await sessionRow(u.session)).stepUpAt).toBeNull(); // the old row wasn't elevated
    expect((await sessionRow(deviceB)).stepUpAt).toBeNull();
    expect(await db().session.count({ where: { userId: u.id, stepUpAt: { not: null } } })).toBe(1);
  });

  it('[S8] an enrolment-only session cannot step up', async () => {
    const admin = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const restricted = sessionOf(await h.login(D, admin.username));
    const res = await stepUp(restricted, { password: PASSWORD });
    expect([res.statusCode, res.json().code]).toEqual([403, 'auth.mfa_enrolment_required']);
    expect((await sessionRow(restricted)).stepUpAt).toBeNull();
  });

  it('[S1] step-up needs a session of THIS tenant, and is a CSRF-protected POST', async () => {
    const u = await plainUser();
    expect((await h.call('POST', D, '/api/v1/auth/step-up', { body: { password: PASSWORD } })).statusCode).toBe(401);
    const otherTenant = await h.call('POST', HOSTS.poly, '/api/v1/auth/step-up', { cookie: u.session, body: { password: PASSWORD } });
    expect(otherTenant.statusCode).toBe(401);
    const crossSite = await h.call('POST', D, '/api/v1/auth/step-up', {
      cookie: u.session,
      body: { password: PASSWORD },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect([crossSite.statusCode, crossSite.json().code]).toEqual([403, 'request.csrf_rejected']);
    expect((await sessionRow(u.session)).revokedAt).toBeNull(); // none of these touched the session
  });
});

describe('atomicity (S7), rate limits and lockout (S5, S12), timing (S11)', () => {
  it('[S7] a TOTP code accepted at login verify cannot be replayed at step-up (shared replay guard)', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const secret = await enrolTestTotp(h.shard, h.tenants.demo, u.id);
    const code = totpCode(secret);
    const session = sessionOf(await verify(challengeOf(await h.login(D, u.username)), { code }));
    const res = await stepUp(session, { password: PASSWORD, code });
    expect([res.statusCode, res.json().code]).toEqual([401, 'auth.mfa_invalid']);
  });

  it('[S7] one TOTP code in parallel on two devices yields exactly one elevated session', async () => {
    const u = await mfaUser();
    const deviceB = await anotherSession(u);
    const code = totpCode(u.secret);
    const results = await Promise.all([u.session, deviceB].map((s) => stepUp(s, { password: PASSWORD, code })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await db().session.count({ where: { userId: u.id, stepUpAt: { not: null } } })).toBe(1);
  });

  it('[S7] parallel step-ups on ONE session: one rotation wins; a losing recovery code is not spent', async () => {
    const u = await mfaUser();
    const [byTotp, byRecovery] = await Promise.all([
      stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret) }),
      stepUp(u.session, { password: PASSWORD, recoveryCode: u.recoveryCodes[3]! }),
    ]);
    expect([byTotp.statusCode, byRecovery.statusCode].sort()).toEqual([200, 401]);
    expect(await db().session.count({ where: { userId: u.id, stepUpAt: { not: null } } })).toBe(1);
    // The loser's transaction rolled back, credential included.
    expect(await db().recoveryCode.count({ where: { userId: u.id, usedAt: null } })).toBe(byRecovery.statusCode === 200 ? 9 : 10);
  });

  it('[S7] one recovery code in parallel on two devices succeeds once, and the user is emailed the remaining count', async () => {
    const u = await mfaUser();
    const deviceB = await anotherSession(u);
    const rc = u.recoveryCodes[0]!;
    const results = await Promise.all([u.session, deviceB].map((s) => stepUp(s, { password: PASSWORD, recoveryCode: rc })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    expect(await db().recoveryCode.count({ where: { userId: u.id, usedAt: null } })).toBe(9);
    const notice = await h.waitForMail(u.email!, /recovery code was used to confirm your identity/, 0);
    expect(notice.text).toContain('9 recovery code(s) remain');
    expect(notice.text).not.toContain(rc);
  });

  it("[S5] step-up attempts count against login's per-IP+user bucket", async () => {
    const u = await plainUser();
    const ip = randomIp();
    for (let i = 0; i < 5; i++) {
      expect((await stepUp(u.session, { password: 'Wrong-Password-12345' }, { ip })).statusCode).toBe(401);
    }
    const login = await h.call('POST', D, '/api/v1/auth/login', { ip, body: { username: u.username, password: PASSWORD } });
    expect(login.statusCode).toBe(429);
    expect(login.headers['retry-after']).toBeDefined();
  });

  it('[S5] a per-user step-up bucket bounds second-factor guessing across rotating IPs', async () => {
    const u = await mfaUser();
    for (let i = 0; i < 10; i++) {
      expect((await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret, 20 + i) })).statusCode).toBe(401);
    }
    const res = await stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret) });
    expect(res.statusCode).toBe(429);
  });

  it('[S12] wrong step-up passwords use login’s counter; 10 lock the account, which also blocks login', async () => {
    const u = await plainUser();
    expect((await stepUp(u.session, { password: 'Wrong-Password-12345' })).statusCode).toBe(401);
    expect((await db().userAccount.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(1);
    // A failed LOGIN adds to the same counter.
    expect((await h.login(D, u.username, 'Wrong-Password-12345')).statusCode).toBe(401);
    expect((await db().userAccount.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(2);
    for (let i = 0; i < 8; i++) await stepUp(u.session, { password: 'Wrong-Password-12345' });
    const locked = await db().userAccount.findUniqueOrThrow({ where: { id: u.id } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await h.login(D, u.username)).statusCode).toBe(401); // correct password, locked
  });

  it('[S12] a locked account cannot step up even with the correct password; success resets the counter', async () => {
    const locked = await plainUser();
    await db().userAccount.update({ where: { id: locked.id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    expect((await stepUp(locked.session, { password: PASSWORD })).statusCode).toBe(401);

    const u = await plainUser();
    await stepUp(u.session, { password: 'Wrong-Password-12345' });
    expect((await stepUp(u.session, { password: PASSWORD })).statusCode).toBe(200);
    expect((await db().userAccount.findUniqueOrThrow({ where: { id: u.id } })).failedLoginCount).toBe(0);
  });

  it('[S11] step-up failures take at least the 400 ms floor (tested conditions only)', async () => {
    const plain = await plainUser();
    const u = await mfaUser();
    const timed = async (call: () => Promise<InjectResult>) => {
      const t0 = performance.now();
      const res = await call();
      return { ms: performance.now() - t0, status: res.statusCode };
    };
    const results = [
      await timed(() => stepUp(plain.session, { password: 'Wrong-Password-12345' })),
      await timed(() => stepUp(u.session, { password: PASSWORD })),
      await timed(() => stepUp(u.session, { password: PASSWORD, code: totpCode(u.secret, 9) })),
      await timed(() => stepUp(u.session, { password: 'Wrong-Password-12345', code: totpCode(u.secret) })),
    ];
    expect(results.map((r) => r.status)).toEqual([401, 400, 401, 401]);
    for (const r of results) expect(r.ms).toBeGreaterThanOrEqual(395);
  });
});

describe('MFA management behind step-up (M9a–M9e, S10)', () => {
  it('[M9a] disable and regenerate answer 428 without a fresh step-up, 200 with one', async () => {
    const u = await mfaUser();
    expect((await disable(u.session)).json().code).toBe('auth.step_up_required');
    expect((await regenerate(u.session)).json().code).toBe('auth.step_up_required');
    const fresh = await steppedUp(u);
    expect((await regenerate(fresh)).statusCode).toBe(200);
    expect((await disable(fresh)).statusCode).toBe(200);
  });

  it('[M9b] regenerate: 10 new codes; every previous code (used or not) dies; other sessions are revoked', async () => {
    const u = await mfaUser();
    const used = u.recoveryCodes[0]!;
    const otherDevice = sessionOf(await verify(challengeOf(await h.login(D, u.username)), { recoveryCode: used }));
    const fresh = await steppedUp(u);
    const res = await regenerate(fresh);
    const codes = res.json().recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.some((c) => u.recoveryCodes.includes(c))).toBe(false);
    expect(await db().recoveryCode.count({ where: { userId: u.id } })).toBe(10);
    expect((await me(otherDevice)).statusCode).toBe(401);
    expect((await me(fresh)).statusCode).toBe(200); // the current session survives
    for (const old of [used, u.recoveryCodes[1]!]) {
      expect((await verify(challengeOf(await h.login(D, u.username)), { recoveryCode: old })).statusCode).toBe(401);
    }
    expect((await verify(challengeOf(await h.login(D, u.username)), { recoveryCode: codes[0]! })).statusCode).toBe(200);
  });

  it('[M9c] disable: factor and codes deleted, other sessions and pending challenges revoked', async () => {
    const u = await mfaUser();
    const otherDevice = await anotherSession(u);
    const pending = challengeOf(await h.login(D, u.username));
    const fresh = await steppedUp(u);
    const res = await disable(fresh);
    expect([res.statusCode, res.json()]).toEqual([200, { mfa: false }]);
    expect(await db().mfaFactor.count({ where: { userId: u.id } })).toBe(0);
    expect(await db().recoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect((await me(otherDevice)).statusCode).toBe(401);
    expect((await verify(pending, { code: totpCode(u.secret) })).statusCode).toBe(401);
    expect((await h.login(D, u.username)).json()).not.toHaveProperty('mfaRequired');
  });

  it('[M9c] a challenge issued before disable stays dead even after the user re-enrols a new factor', async () => {
    // The test above can't tell whether challenges were revoked: deleting the factor alone makes the
    // old challenge unusable. Re-enrolling a NEW factor removes that mask — without revocation the
    // pre-disable challenge accepted the new factor's code and logged in (mutation-tested 2026-10-02).
    const u = await mfaUser();
    const pending = challengeOf(await h.login(D, u.username)); // started under the OLD factor
    const res = await disable(await steppedUp(u));
    expect(res.statusCode).toBe(200);
    const current = sessionOf(res);
    const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: current, body: { password: PASSWORD } });
    const newSecret = base32Decode(begin.json().secret);
    const confirm = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: current, body: { code: totpCode(newSecret) } });
    expect(confirm.statusCode).toBe(200);
    await resetReplayGuard(h.shard, h.tenants.demo, u.id);
    expect((await verify(pending, { code: totpCode(newSecret) })).statusCode).toBe(401);
  });

  it('[M9d] non-privileged: the current session rotates to a normal one with mfa_at and step_up_at cleared', async () => {
    const u = await mfaUser();
    const fresh = await steppedUp(u);
    const res = await disable(fresh);
    const next = sessionOf(res);
    expect(next).not.toBe(fresh);
    expect((await me(fresh)).statusCode).toBe(401);
    expect((await me(next)).json()).toMatchObject({ mfa: false, restricted: false });
    expect(await sessionRow(next)).toMatchObject({ restricted: false, mfaAt: null, stepUpAt: null });
  });

  it('[M9d] privileged: disabling MFA leaves the CURRENT session enrolment-only in the same response', async () => {
    const admin = await mfaUser('INSTITUTION_ADMIN');
    expect((await h.call('GET', D, '/api/v1/users', { cookie: admin.session })).statusCode).toBe(200);
    const fresh = await steppedUp(admin);
    const res = await disable(fresh);
    expect([res.statusCode, res.json()]).toEqual([200, { mfa: false, mfaEnrolmentRequired: true }]);
    const next = sessionOf(res);
    expect(await sessionRow(next)).toMatchObject({ restricted: true, mfaAt: null, stepUpAt: null });
    expect((await me(fresh)).statusCode).toBe(401); // the elevated token is gone
    const users = await h.call('GET', D, '/api/v1/users', { cookie: next });
    expect([users.statusCode, users.json().code]).toEqual([403, 'auth.mfa_enrolment_required']);
    // The M8 allow-list still works: /me and enrolment.
    expect((await me(next)).json()).toMatchObject({ restricted: true, mfa: false });
    const enrol = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: next, body: { password: PASSWORD } });
    expect(enrol.statusCode).toBe(200);
  });

  it('[M9e] disable and regenerate email the user, with no codes in the email', async () => {
    const u = await mfaUser();
    const fresh = await steppedUp(u);
    const codes = (await regenerate(fresh)).json().recoveryCodes as string[];
    const regenMail = await h.waitForMail(u.email!, /recovery codes were regenerated/, 0);
    expect((await disable(fresh)).statusCode).toBe(200);
    const disableMail = await h.waitForMail(u.email!, /MFA was turned off/, 0);
    for (const mail of [regenMail, disableMail]) {
      for (const c of [...codes, ...u.recoveryCodes]) expect(mail.text).not.toContain(c);
      expect(mail.text).not.toMatch(/\b\d{6}\b/);
    }
  });

  it('[S10] parallel regenerates leave exactly one complete set of 10 codes', async () => {
    const u = await mfaUser();
    const fresh = await steppedUp(u);
    const results = await Promise.all(Array.from({ length: 5 }, () => regenerate(fresh)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const stored = (await db().recoveryCode.findMany({ where: { userId: u.id } })).map((r) => Buffer.from(r.codeHash).toString('hex')).sort();
    expect(stored).toHaveLength(10);
    const sets = results.map((r) => (r.json().recoveryCodes as string[]).map((c) => recoveryHash(u.id, c)).sort());
    expect(sets.filter((s) => JSON.stringify(s) === JSON.stringify(stored))).toHaveLength(1);
  });

  it('[S10] parallel regenerates from two devices: the per-user lock leaves exactly one set', async () => {
    const u = await mfaUser();
    const deviceA = await steppedUp(u);
    const deviceB = await steppedUp({ ...u, session: await anotherSession(u) });
    const results = await Promise.all([regenerate(deviceA), regenerate(deviceB)]);
    // The winner revokes the other device, which then fails its liveness check under the lock.
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    const stored = (await db().recoveryCode.findMany({ where: { userId: u.id } })).map((r) => Buffer.from(r.codeHash).toString('hex')).sort();
    const winner = results.find((r) => r.statusCode === 200)!.json().recoveryCodes as string[];
    expect(stored).toEqual(winner.map((c) => recoveryHash(u.id, c)).sort());
  });

  it('[S10] parallel disables: one wins; no factor, no codes, one live session', async () => {
    const u = await mfaUser();
    const fresh = await steppedUp(u);
    const results = await Promise.all(Array.from({ length: 5 }, () => disable(fresh)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of results.filter((r) => r.statusCode !== 200)) expect([401, 409]).toContain(r.statusCode);
    expect(await db().mfaFactor.count({ where: { userId: u.id } })).toBe(0);
    expect(await db().recoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect(await db().session.count({ where: { userId: u.id, revokedAt: null } })).toBe(1);
  });

  it('[S10] disable racing regenerate on one session: never a factor-less user with live recovery codes', async () => {
    const u = await mfaUser();
    const fresh = await steppedUp(u);
    const [d, r] = await Promise.all([disable(fresh), regenerate(fresh)]);
    expect(d.statusCode).toBe(200);
    expect([200, 401]).toContain(r.statusCode);
    expect(await db().mfaFactor.count({ where: { userId: u.id } })).toBe(0);
    expect(await db().recoveryCode.count({ where: { userId: u.id } })).toBe(0);
  });
});
