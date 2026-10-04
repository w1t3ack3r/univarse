/**
 * Spec 0002 A6/A7 — identity flows emit audit events in the same transaction, without secrets,
 * and the tenant's chain stays valid. Every AC ID appears in a test name.
 */
import { forTenant, withTenantTx } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../shared/audit/audit-writer.js';
import { codeIn, createHarness, HOSTS, PASSWORD, randomIp, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { base32Decode } from './totp.js';

let h: Harness;
const D = HOSTS.demo;
const cookies = (res: InjectResult): string[] => {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
};
const sessionOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
const challengeOf = (res: InjectResult) => cookies(res).find((c) => c.startsWith('__Host-uv_mfa=') && c.length > 20)!;

/** All audit events whose actor is this user, oldest first. */
const eventsFor = (userId: string) =>
  forTenant(h.shard, h.tenants.demo).auditEvent.findMany({ where: { actorId: userId }, orderBy: { seq: 'asc' } });
const actions = async (userId: string) => (await eventsFor(userId)).map((e) => e.action);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('identity audit events (spec 0002 A6/A7)', () => {
  it('[A7] successful login: event with session entity, ip, user agent and request id', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const ip = randomIp();
    await h.call('POST', D, '/api/v1/auth/login', { ip, body: { username: u.username, password: PASSWORD }, headers: { 'x-request-id': `req-login-${h.run}` } });
    const [e] = await eventsFor(u.id);
    expect(e).toMatchObject({ action: 'auth.login.succeeded', actorType: 'USER', entityType: 'session', ip, requestId: `req-login-${h.run}` });
    expect(e!.userAgent).toBeTruthy();
    expect(e!.entityId).toBeTruthy();
  });

  it('[A7] failed login on a known account, then lockout after 10', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await h.login(D, u.username, 'wrong-password-1');
    expect(await actions(u.id)).toEqual(['auth.login.failed']);
    expect((await eventsFor(u.id))[0]!.after).toMatchObject({ context: 'login', failedLoginCount: 1 });
    for (let i = 2; i <= 10; i++) await h.login(D, u.username, `wrong-password-${i}`);
    const acts = await actions(u.id);
    expect(acts.filter((a) => a === 'auth.login.failed')).toHaveLength(10);
    expect(acts.at(-1)).toBe('auth.account.locked');
  });

  it('[A7] logout is recorded', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const s = sessionOf(await h.login(D, u.username));
    await h.call('POST', D, '/api/v1/auth/logout', { cookie: s });
    expect(await actions(u.id)).toEqual(['auth.login.succeeded', 'auth.logout']);
  });

  it('[A7][A6] activation and password reset are recorded without any password, code or hash', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT', status: 'PENDING_ACTIVATION' });
    const act = await h.call('POST', D, '/api/v1/auth/activation/request', { body: { username: u.username } });
    expect(act.statusCode).toBe(202);
    const actCode = codeIn(await h.waitForMail(u.email!, /activation code/, 0));
    const activatedPw = 'Audit-Activation-Pass-1';
    await h.call('POST', D, '/api/v1/auth/activation/confirm', { body: { username: u.username, code: actCode, password: activatedPw } });

    await h.call('POST', D, '/api/v1/auth/password-reset/request', { body: { username: u.username } });
    const resetCode = codeIn(await h.waitForMail(u.email!, /reset code/, 0));
    const resetPw = 'Audit-Reset-Password-2';
    await h.call('POST', D, '/api/v1/auth/password-reset/confirm', { body: { username: u.username, code: resetCode, password: resetPw } });

    expect(await actions(u.id)).toEqual(['auth.activation.completed', 'auth.password_reset.completed']);
    const blob = JSON.stringify(await eventsFor(u.id), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const secret of [activatedPw, resetPw, actCode, resetCode, '$argon2id']) expect(blob).not.toContain(secret);
  });

  it('[A7] MFA enrolment, step-up, recovery-code use, regeneration and disable are recorded', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const s = sessionOf(await h.login(D, u.username));
    const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: s, body: { password: PASSWORD } });
    const secret = base32Decode(begin.json().secret);
    const confirm = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: s, body: { code: totpCode(secret) } });
    const rc = confirm.json().recoveryCodes as string[];
    const full = sessionOf(confirm);

    // Login via recovery code → recovery_code_used + login.succeeded (mfa).
    const ch = challengeOf(await h.login(D, u.username));
    await h.call('POST', D, '/api/v1/auth/mfa/verify', { cookie: ch, body: { recoveryCode: rc[0]! } });

    await resetReplayGuard(h.shard, h.tenants.demo, u.id);
    const up = await h.call('POST', D, '/api/v1/auth/step-up', { cookie: full, body: { password: PASSWORD, code: totpCode(secret) } });
    const elevated = sessionOf(up);
    await h.call('POST', D, '/api/v1/auth/mfa/recovery-codes/regenerate', { cookie: elevated, body: {} });
    await h.call('POST', D, '/api/v1/auth/mfa/totp/disable', { cookie: elevated, body: {} });

    expect(await actions(u.id)).toEqual([
      'auth.login.succeeded',
      'auth.mfa.enrolled',
      'auth.mfa.recovery_code_used',
      'auth.login.succeeded',
      'auth.step_up.succeeded',
      'auth.mfa.recovery_codes_regenerated',
      'auth.mfa.disabled',
    ]);
    const evs = await eventsFor(u.id);
    expect(evs[2]!.after).toEqual({ remaining: 9, context: 'login' });
    expect(evs[3]!.after).toEqual({ mfa: true, restricted: false });
    expect(evs[4]!.after).toEqual({ secondFactor: 'totp' });
    const blob = JSON.stringify(evs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const code of rc) expect(blob).not.toContain(code);
    expect(blob).not.toContain(begin.json().secret);
  });

  it('[A7] a failed step-up password is recorded with context step_up', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const s = sessionOf(await h.login(D, u.username));
    await h.call('POST', D, '/api/v1/auth/step-up', { cookie: s, body: { password: 'nope-not-it-1' } });
    const failed = (await eventsFor(u.id)).find((e) => e.action === 'auth.login.failed');
    expect(failed?.after).toMatchObject({ context: 'step_up' });
  });

  it('[A1][A2] after all these flows the institution’s whole chain still verifies', async () => {
    const result = await withTenantTx(h.shard, h.tenants.demo, (tx) => verifyAuditChain(tx, h.tenants.demo));
    expect(result.ok).toBe(true);
  });
});

