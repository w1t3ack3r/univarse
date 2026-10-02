/**
 * Spec 0001 Part M — TOTP MFA. Every AC ID (M1–M15) appears in a test name.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running.
 */
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeIn, cookieFrom, createHarness, HOSTS, PASSWORD, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { enrolTestTotp, resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { base32Decode, hotp, timeStep } from './totp.js';

let h: Harness;
const D = HOSTS.demo;
const cookies = (res: InjectResult): string[] => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
};
const sessionOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
const challengeOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_mfa=') && c.length > 20)!;
const verify = (challenge: string, body: object) => h.call('POST', D, '/api/v1/auth/mfa/verify', { cookie: challenge, body });
const me = (cookie: string) => h.call('GET', D, '/api/v1/auth/me', { cookie });

/** Full enrolment through the API from a normal (non-privileged) session. */
async function enrolViaApi(username: string) {
  const session = sessionOf(await h.login(D, username));
  const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: session, body: { password: PASSWORD } });
  expect(begin.statusCode).toBe(200);
  const secret = base32Decode(begin.json().secret);
  const confirm = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: session, body: { code: totpCode(secret) } });
  expect(confirm.statusCode).toBe(200);
  return { oldSession: session, newSession: sessionOf(confirm), secret, recoveryCodes: confirm.json().recoveryCodes as string[], begin: begin.json() };
}

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('enrolment (M1-M3, M14, M15)', () => {
  it('[M1] returns the secret + otpauth URI once and stores the secret only encrypted', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { begin, secret } = await enrolViaApi(u.username);
    expect(begin.otpauthUri).toMatch(/^otpauth:\/\/totp\/.+\?secret=[A-Z2-7]+&issuer=/);
    const factor = await forTenant(h.shard, h.tenants.demo).mfaFactor.findFirstOrThrow({ where: { userId: u.id } });
    expect(factor.secretEnc).toMatch(/^v1:[a-z0-9-]+:/);
    expect(factor.secretEnc).not.toContain(begin.secret);
    expect(factor.secretEnc).not.toContain(secret.toString('base64'));
  });

  it('[M1] enrolment requires the current password', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const session = sessionOf(await h.login(D, u.username));
    const res = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: session, body: { password: 'wrong-password-123' } });
    expect(res.statusCode).toBe(401);
  });

  it('[M2] a factor is inactive until confirmed; a wrong code does not confirm it', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const session = sessionOf(await h.login(D, u.username));
    const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: session, body: { password: PASSWORD } });
    const secret = base32Decode(begin.json().secret);
    const wrong = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: session, body: { code: totpCode(secret, 5) } });
    expect(wrong.statusCode).toBe(401);
    // Unconfirmed ⇒ login still gives a plain session, no challenge.
    expect((await h.login(D, u.username)).json()).not.toHaveProperty('mfaRequired');
  });

  it('[M2] unconfirmed factors expire after 15 minutes', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const session = sessionOf(await h.login(D, u.username));
    const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: session, body: { password: PASSWORD } });
    await forTenant(h.shard, h.tenants.demo).mfaFactor.updateMany({ where: { userId: u.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    const res = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: session, body: { code: totpCode(base32Decode(begin.json().secret)) } });
    expect(res.json().code).toBe('auth.mfa_enrolment_expired');
  });

  it('[M3] ten distinct recovery codes are returned once and stored only hashed', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { recoveryCodes } = await enrolViaApi(u.username);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    const rows = await forTenant(h.shard, h.tenants.demo).recoveryCode.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(10);
    for (const r of rows) expect(Buffer.from(r.codeHash).toString('utf8')).not.toContain(recoveryCodes[0]!.slice(0, 5));
  });

  it('[M14] confirming enrolment retires the enrolling session and issues a new full session', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { oldSession, newSession } = await enrolViaApi(u.username);
    expect(newSession).not.toBe(oldSession);
    expect((await me(oldSession)).statusCode).toBe(401);
    expect((await me(newSession)).json()).toMatchObject({ mfa: true, restricted: false });
  });

  it("[M15′] management endpoints exist only behind step-up (428 without it); unknown ones 404; re-enrolment 409", async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { newSession } = await enrolViaApi(u.username);
    for (const path of ['/api/v1/auth/mfa/totp/disable', '/api/v1/auth/mfa/recovery-codes/regenerate']) {
      const res = await h.call('POST', D, path, { cookie: newSession, body: {} });
      expect([res.statusCode, res.json().code]).toEqual([428, 'auth.step_up_required']);
    }
    expect((await h.call('POST', D, '/api/v1/auth/mfa/totp/remove', { cookie: newSession, body: {} })).statusCode).toBe(404);
    const again = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: newSession, body: { password: PASSWORD } });
    expect(again.statusCode).toBe(409);
  });
});

describe('login with MFA (M4–M7, M10)', () => {
  async function mfaUser() {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    return { ...u, secret: await enrolTestTotp(h.shard, h.tenants.demo, u.id) };
  }

  it('[M4] a correct password yields a challenge (not a session); verify yields a full session', async () => {
    const u = await mfaUser();
    const first = await h.login(D, u.username);
    expect(first.json()).toEqual({ mfaRequired: true });
    expect(cookies(first).some((c) => c.startsWith('__Host-uv_sid='))).toBe(false);
    const challenge = challengeOf(first);
    expect((await me(challenge.replace('__Host-uv_mfa', '__Host-uv_sid'))).statusCode).toBe(401); // a challenge is not a session
    const done = await verify(challenge, { code: totpCode(u.secret) });
    expect(done.statusCode).toBe(200);
    expect((await me(sessionOf(done))).json()).toMatchObject({ mfa: true });
    expect(String(done.headers['set-cookie'])).toContain('__Host-uv_mfa=; ');
  });

  it('[M4] a used challenge cannot be reused', async () => {
    const u = await mfaUser();
    const challenge = challengeOf(await h.login(D, u.username));
    expect((await verify(challenge, { code: totpCode(u.secret) })).statusCode).toBe(200);
    await resetReplayGuard(h.shard, h.tenants.demo, u.id);
    expect((await verify(challenge, { code: totpCode(u.secret) })).statusCode).toBe(401);
  });

  it('[M4] a challenge consumed by TOTP cannot be reused with a different valid credential (unused recovery code)', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { recoveryCodes, secret } = await enrolViaApi(u.username);
    await resetReplayGuard(h.shard, h.tenants.demo, u.id); // enrolment confirm used the current step
    const challenge = challengeOf(await h.login(D, u.username));
    expect((await verify(challenge, { code: totpCode(secret) })).statusCode).toBe(200);
    // Fresh, never-used credential of a different kind on the SAME challenge → refused.
    expect((await verify(challenge, { recoveryCode: recoveryCodes[0]! })).statusCode).toBe(401);
    // …and the refused attempt did not burn the recovery code.
    expect(await forTenant(h.shard, h.tenants.demo).recoveryCode.count({ where: { userId: u.id, usedAt: null } })).toBe(10);
  });

  it('[M4][M12] TOTP and recovery code in parallel on one challenge: exactly one session, nothing else consumed', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { recoveryCodes, secret } = await enrolViaApi(u.username);
    await resetReplayGuard(h.shard, h.tenants.demo, u.id);
    const challenge = challengeOf(await h.login(D, u.username));
    const [byTotp, byRecovery] = await Promise.all([
      verify(challenge, { code: totpCode(secret) }),
      verify(challenge, { recoveryCode: recoveryCodes[1]! }),
    ]);
    expect([byTotp.statusCode, byRecovery.statusCode].sort()).toEqual([200, 401]);
    const unused = await forTenant(h.shard, h.tenants.demo).recoveryCode.count({ where: { userId: u.id, usedAt: null } });
    // The recovery code is spent only if it was the winner.
    expect(unused).toBe(byRecovery.statusCode === 200 ? 9 : 10);
    const sessions = await forTenant(h.shard, h.tenants.demo).session.count({ where: { userId: u.id, mfaAt: { not: null }, revokedAt: null } });
    expect(sessions).toBe(2); // the enrolment session + exactly one from this challenge
  });

  it('[M4] an expired challenge is rejected', async () => {
    const u = await mfaUser();
    const challenge = challengeOf(await h.login(D, u.username));
    await forTenant(h.shard, h.tenants.demo).mfaChallenge.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(challenge, { code: totpCode(u.secret) })).statusCode).toBe(401);
  });

  it('[M5] the same TOTP time step is accepted once, even across challenges', async () => {
    const u = await mfaUser();
    const code = totpCode(u.secret);
    expect((await verify(challengeOf(await h.login(D, u.username)), { code })).statusCode).toBe(200);
    expect((await verify(challengeOf(await h.login(D, u.username)), { code })).statusCode).toBe(401);
  });

  it('[M5] ±1 step of clock skew is tolerated; ±2 is not', async () => {
    const u = await mfaUser();
    const step = timeStep(Date.now());
    expect((await verify(challengeOf(await h.login(D, u.username)), { code: hotp(u.secret, step + 2) })).statusCode).toBe(401);
    expect((await verify(challengeOf(await h.login(D, u.username)), { code: hotp(u.secret, step - 1) })).statusCode).toBe(200);
  });

  it('[M6] five wrong codes kill the challenge, even for a correct sixth', async () => {
    const u = await mfaUser();
    const challenge = challengeOf(await h.login(D, u.username));
    for (let i = 0; i < 5; i++) expect((await verify(challenge, { code: totpCode(u.secret, 10 + i) })).statusCode).toBe(401);
    expect((await verify(challenge, { code: totpCode(u.secret) })).statusCode).toBe(401);
  });

  it('[M7] a recovery code works exactly once and the user is emailed the remaining count', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { recoveryCodes } = await enrolViaApi(u.username);
    const rc = recoveryCodes[0]!;
    const ok = await verify(challengeOf(await h.login(D, u.username)), { recoveryCode: rc.toLowerCase() }); // case-insensitive
    expect(ok.statusCode).toBe(200);
    expect((await verify(challengeOf(await h.login(D, u.username)), { recoveryCode: rc })).statusCode).toBe(401);
    const notice = await h.waitForMail(u.email!, /recovery code was used/, 0);
    expect(notice.text).toContain('9 recovery code(s) remain');
  });

  it('[M10] a password reset does not remove or bypass MFA', async () => {
    const u = await mfaUser();
    const before = h.mailsTo(u.email!).filter((m) => /reset code/.test(m.subject)).length;
    await h.call('POST', D, '/api/v1/auth/password-reset/request', { body: { username: u.username } });
    const code = codeIn(await h.waitForMail(u.email!, /reset code/, before));
    await h.call('POST', D, '/api/v1/auth/password-reset/confirm', { body: { username: u.username, code, password: 'After-Reset-Password-1' } });
    expect((await h.login(D, u.username, 'After-Reset-Password-1')).json()).toEqual({ mfaRequired: true });
  });
});

describe('privileged users (M8) and reset interplay (M11)', () => {
  it('[M8] a privileged user without a factor gets an enrolment-only session', async () => {
    const admin = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const res = await h.login(D, admin.username);
    expect(res.json()).toMatchObject({ mfaEnrolmentRequired: true });
    const session = sessionOf(res);
    expect((await me(session)).json()).toMatchObject({ restricted: true, mfa: false });
    const users = await h.call('GET', D, '/api/v1/users', { cookie: session });
    expect([users.statusCode, users.json().code]).toEqual([403, 'auth.mfa_enrolment_required']);
    expect((await h.call('POST', D, '/api/v1/auth/logout', { cookie: session })).statusCode).toBe(204);
  });

  it('[M8][M14] enrolling upgrades the admin to a full session; other restricted sessions stay restricted', async () => {
    const admin = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const otherDevice = sessionOf(await h.login(D, admin.username));
    const { oldSession, newSession } = await enrolViaApi(admin.username);
    expect((await me(oldSession)).statusCode).toBe(401);
    expect((await h.call('GET', D, '/api/v1/users', { cookie: newSession })).statusCode).toBe(200);
    expect((await h.call('GET', D, '/api/v1/users', { cookie: otherDevice })).json().code).toBe('auth.mfa_enrolment_required');
  });

  it('[M11] a password reset revokes pending MFA challenges (R16)', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const secret = await enrolTestTotp(h.shard, h.tenants.demo, u.id);
    const challenge = challengeOf(await h.login(D, u.username));
    const before = h.mailsTo(u.email!).filter((m) => /reset code/.test(m.subject)).length;
    await h.call('POST', D, '/api/v1/auth/password-reset/request', { body: { username: u.username } });
    const code = codeIn(await h.waitForMail(u.email!, /reset code/, before));
    await h.call('POST', D, '/api/v1/auth/password-reset/confirm', { body: { username: u.username, code, password: 'Post-Reset-Password-2' } });
    expect((await verify(challenge, { code: totpCode(secret) })).statusCode).toBe(401);
  });
});

describe('concurrency (M12) and timing (M13)', () => {
  it('[M12] parallel verifies of one challenge yield at most one session', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const secret = await enrolTestTotp(h.shard, h.tenants.demo, u.id);
    const challenge = challengeOf(await h.login(D, u.username));
    const code = totpCode(secret);
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(challenge, { code })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('[M12] parallel wrong codes cannot exceed the challenge budget', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const secret = await enrolTestTotp(h.shard, h.tenants.demo, u.id);
    const challenge = challengeOf(await h.login(D, u.username));
    await Promise.all(Array.from({ length: 12 }, (_, i) => verify(challenge, { code: totpCode(secret, 20 + i) })));
    const row = await forTenant(h.shard, h.tenants.demo).mfaChallenge.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.attempts).toBeLessThanOrEqual(5);
    expect((await verify(challenge, { code: totpCode(secret) })).statusCode).toBe(401);
  });

  it('[M12] one recovery code used in parallel on two challenges succeeds once', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const { recoveryCodes } = await enrolViaApi(u.username);
    const [c1, c2] = [challengeOf(await h.login(D, u.username)), challengeOf(await h.login(D, u.username))];
    const results = await Promise.all([verify(c1, { recoveryCode: recoveryCodes[0]! }), verify(c2, { recoveryCode: recoveryCodes[0]! })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('[M13] verify timing: unknown challenge vs valid challenge with a wrong code (tested conditions only)', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const secret = await enrolTestTotp(h.shard, h.tenants.demo, u.id);
    // Prepare real challenges first so only the verify call itself is timed.
    const real: string[] = [];
    for (let i = 0; i < 7; i++) real.push(challengeOf(await h.login(D, u.username)));
    const timeEach = async (calls: (() => Promise<unknown>)[]) => {
      const ms: number[] = [];
      for (const call of calls) {
        const t0 = performance.now();
        await call();
        ms.push(performance.now() - t0);
      }
      return ms.sort((a, b) => a - b)[3]!; // median of 7
    };
    const unknown = await timeEach(Array.from({ length: 7 }, () => () => verify(`__Host-uv_mfa=${'A'.repeat(43)}`, { code: '123456' })));
    const wrong = await timeEach(real.map((c) => () => verify(c, { code: totpCode(secret, 9) })));
    // Without the floor, wrong-code verifies were measured ~3–4 ms slower, consistently (DB + decrypt).
    // A 40 ms tolerance cannot see that, so also assert the floor itself is in force on both paths.
    expect(Math.min(unknown, wrong)).toBeGreaterThanOrEqual(395);
    expect(Math.abs(unknown - wrong)).toBeLessThan(40);
  });
});
