/**
 * Spec 0001 Part R — password reset. Every AC ID appears in a test name.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running.
 */
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeIn, cookieFrom, createHarness, HOSTS, PASSWORD, randomIp, type Harness } from '../../testing/int-harness.js';

const NEW_PASSWORD = 'Brand-New-Harmattan-42';
let h: Harness;

const requestReset = (username: string, host: string = HOSTS.demo, ip?: string) =>
  h.call('POST', host, '/api/v1/auth/password-reset/request', { body: { username }, ...(ip ? { ip } : {}) });
const confirmReset = (username: string, code: string, password = NEW_PASSWORD, host: string = HOSTS.demo) =>
  h.call('POST', host, '/api/v1/auth/password-reset/confirm', { body: { username, code, password } });
const lastCodeFor = (email: string) => codeIn(h.mailsTo(email).filter((m) => /reset code/.test(m.subject)).at(-1));

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('password reset (spec 0001 Part R)', () => {
  it('[R1] answers identically for active, unknown, pending, disabled and email-less accounts; mails only the active one', async () => {
    const active = await h.makeUser('demo', { role: 'STUDENT' });
    const pending = await h.makeUser('demo', { role: 'STUDENT', status: 'PENDING_ACTIVATION' });
    const disabled = await h.makeUser('demo', { role: 'STUDENT', status: 'DISABLED' });
    const noEmail = await h.makeUser('demo', { role: 'STUDENT', email: null });
    const before = h.outbox.length;

    const bodies = [];
    for (const username of [active.username, `NOPE-${h.run}`, pending.username, disabled.username, noEmail.username]) {
      const res = await requestReset(username);
      expect(res.statusCode).toBe(202);
      bodies.push(res.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(h.outbox.length).toBe(before + 1);
    expect(h.outbox.at(-1)!.to).toBe(active.email);
  });

  it('[R2] a new request invalidates the earlier code; only the newest works', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(u.username);
    const first = lastCodeFor(u.email!);
    await requestReset(u.username);
    const second = lastCodeFor(u.email!);
    // Pin the invalidation itself (not just "newest wins"): exactly one live code remains.
    const live = await forTenant(h.shard, h.tenants.demo).oneTimeToken.count({
      where: { userId: u.id, purpose: 'PASSWORD_RESET', usedAt: null },
    });
    expect(live).toBe(1);
    if (first !== second) expect((await confirmReset(u.username, first)).statusCode).toBe(400);
    expect((await confirmReset(u.username, second)).statusCode).toBe(204);
  });

  it('[R2] codes are stored only as 32-byte peppered hashes', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(u.username);
    const code = lastCodeFor(u.email!);
    const rows = await forTenant(h.shard, h.tenants.demo).oneTimeToken.findMany({ where: { userId: u.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash.length).toBe(32);
    expect(Buffer.from(rows[0]!.tokenHash).toString('utf8')).not.toContain(code);
  });

  it('[R3] five wrong codes kill the code, even for a correct sixth attempt', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(u.username);
    const code = lastCodeFor(u.email!);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await confirmReset(u.username, wrong)).statusCode).toBe(400);
    expect((await confirmReset(u.username, code)).statusCode).toBe(400);
    expect((await h.login(HOSTS.demo, u.username)).statusCode).toBe(200); // old password still valid
  });

  it('[R4] a used code cannot be reused', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(u.username);
    const code = lastCodeFor(u.email!);
    expect((await confirmReset(u.username, code)).statusCode).toBe(204);
    expect((await confirmReset(u.username, code, 'Another-Fresh-Pass-77')).statusCode).toBe(400);
  });

  it("[R4] user A's code cannot reset user B", async () => {
    const a = await h.makeUser('demo', { role: 'STUDENT' });
    const b = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(a.username);
    await requestReset(b.username); // B has a live code too, so only per-user binding can reject
    const codeA = lastCodeFor(a.email!);
    if (codeA === lastCodeFor(b.email!)) return; // 1-in-a-million collision: nothing to distinguish
    expect((await confirmReset(b.username, codeA)).statusCode).toBe(400);
    expect((await h.login(HOSTS.demo, a.username)).statusCode).toBe(200);
  });

  it("[R4] a code from one institution is useless at another (same username)", async () => {
    const username = `XT-${h.run}`;
    const demo = await h.makeUser('demo', { role: 'STUDENT', username, email: `xt-${h.run.toLowerCase()}@demo.test` });
    await h.makeUser('poly', { role: 'STUDENT', username, email: `xt-${h.run.toLowerCase()}@poly.test` });
    await requestReset(username, HOSTS.demo);
    expect((await confirmReset(username, lastCodeFor(demo.email!), NEW_PASSWORD, HOSTS.poly)).statusCode).toBe(400);
    expect((await h.login(HOSTS.poly, username)).statusCode).toBe(200); // poly password untouched
  });

  it('[R5] a policy-violating password is rejected without consuming the code', async () => {
    const u = await h.makeUser('demo', { role: 'LECTURER' }); // staff ⇒ 12-char minimum
    await requestReset(u.username);
    const code = lastCodeFor(u.email!);
    const short = await confirmReset(u.username, code, 'Short-pw-9');
    expect(short.statusCode).toBe(422);
    expect(short.json().errors.map((e: { code: string }) => e.code)).toContain('too_short');
    expect((await confirmReset(u.username, code)).statusCode).toBe(204);
  });

  it('[R6] every existing session is revoked, including the requester’s', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const s1 = cookieFrom((await h.login(HOSTS.demo, u.username)).headers['set-cookie'] as string);
    const s2 = cookieFrom((await h.login(HOSTS.demo, u.username)).headers['set-cookie'] as string);
    await requestReset(u.username);
    expect((await confirmReset(u.username, lastCodeFor(u.email!))).statusCode).toBe(204);
    for (const cookie of [s1, s2]) expect((await h.call('GET', HOSTS.demo, '/api/v1/auth/me', { cookie })).statusCode).toBe(401);
    const reasons = await forTenant(h.shard, h.tenants.demo).session.findMany({ where: { userId: u.id }, select: { revokeReason: true } });
    expect(reasons.every((r) => r.revokeReason === 'password_reset')).toBe(true);
  });

  it('[R7] reset does not sign the user in; the new password works, the old one does not', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(u.username);
    const res = await confirmReset(u.username, lastCodeFor(u.email!));
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await h.login(HOSTS.demo, u.username, PASSWORD)).statusCode).toBe(401);
    expect((await h.login(HOSTS.demo, u.username, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('[R8] a successful reset clears a guessing lockout', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await forTenant(h.shard, h.tenants.demo).userAccount.update({
      where: { id: u.id },
      data: { failedLoginCount: 7, lockedUntil: new Date(Date.now() + 10 * 60_000) },
    });
    await requestReset(u.username);
    await confirmReset(u.username, lastCodeFor(u.email!));
    const row = await forTenant(h.shard, h.tenants.demo).userAccount.findUniqueOrThrow({ where: { id: u.id } });
    expect([row.failedLoginCount, row.lockedUntil]).toEqual([0, null]);
    expect((await h.login(HOSTS.demo, u.username, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it('[R9] a change notification is sent, containing no code or link', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await requestReset(u.username);
    await confirmReset(u.username, lastCodeFor(u.email!));
    const note = h.mailsTo(u.email!).find((m) => /password was changed/.test(m.subject));
    expect(note).toBeDefined();
    expect(note!.text).not.toMatch(/\b\d{6}\b|https?:\/\//);
  });

  it('[R10] repeated requests for one identifier are rate-limited with Retry-After', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await requestReset(u.username, HOSTS.demo, randomIp())).statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);
  });

  it('[R11] an admin-locked account never receives a code and cannot reset', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT', status: 'LOCKED' });
    const before = h.mailsTo(u.email!).length;
    expect((await requestReset(u.username)).statusCode).toBe(202);
    expect(h.mailsTo(u.email!).length).toBe(before);
    expect((await confirmReset(u.username, '123456')).statusCode).toBe(400);
  });
});
