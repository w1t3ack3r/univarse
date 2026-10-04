/**
 * Spec 0001 R12–R15 (review follow-up): concurrency, eligibility re-check, timing.
 * R16 (reset invalidates pending MFA challenges) lands with Part M — tracked in the spec.
 */
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeIn, createHarness, HOSTS, PASSWORD, type Harness } from '../../testing/int-harness.js';

let h: Harness;
const NEW = 'Concurrency-Harmattan-88';
const request = (username: string) => h.call('POST', HOSTS.demo, '/api/v1/auth/password-reset/request', { body: { username } });
/** Requests a reset and waits for the (asynchronously sent) email. */
const requestAndGetCode = async (u: { username: string; email: string | null }) => {
  const before = h.mailsTo(u.email!).filter((m) => /reset code/.test(m.subject)).length;
  await request(u.username);
  return codeIn(await h.waitForMail(u.email!, /reset code/, before));
};
const confirm = (username: string, code: string, password = NEW) =>
  h.call('POST', HOSTS.demo, '/api/v1/auth/password-reset/confirm', { body: { username, code, password } });

beforeAll(async () => {
  // Realistic SMTP latency so the timing tests (R15) can actually detect an awaited send.
  h = await createHarness({ mailDelayMs: 250 });
});
afterAll(async () => {
  await h.close();
});

describe('reset hardening (spec 0001 R12–R15)', () => {
  it('[R12] concurrent confirmations with the correct code: exactly one succeeds', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const code = await requestAndGetCode(u);
    const results = await Promise.all(
      ['Parallel-One-Pass-11', 'Parallel-Two-Pass-22', 'Parallel-Three-Pass-33', 'Parallel-Four-Pass-44'].map((p) => confirm(u.username, code, p)),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 400, 400, 400]);
  });

  it('[R13] concurrent wrong guesses cannot exceed the 5-attempt budget', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const code = await requestAndGetCode(u);
    const wrong = Array.from({ length: 12 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0'));
    await Promise.all(wrong.map((w) => confirm(u.username, w)));
    const token = await forTenant(h.shard, h.tenants.demo).oneTimeToken.findFirstOrThrow({
      where: { userId: u.id, purpose: 'PASSWORD_RESET' },
      orderBy: { createdAt: 'desc' },
    });
    expect(token.attempts).toBeLessThanOrEqual(5);
    expect((await confirm(u.username, code)).statusCode).toBe(400);
  });

  it.each(['DISABLED', 'LOCKED'] as const)('[R14] eligibility is re-checked at confirm: account %s after the code was issued', async (status) => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const code = await requestAndGetCode(u);
    await forTenant(h.shard, h.tenants.demo).userAccount.update({ where: { id: u.id }, data: { status } });
    expect((await confirm(u.username, code)).statusCode).toBe(400);
    await forTenant(h.shard, h.tenants.demo).userAccount.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
    expect((await h.login(HOSTS.demo, u.username, PASSWORD)).statusCode).toBe(200); // password unchanged
  });

  it('[R15] request timing does not reveal whether an account exists', async () => {
    const samples = async (make: () => Promise<string>) => {
      const ms: number[] = [];
      for (let i = 0; i < 7; i++) {
        const username = await make();
        const t0 = performance.now();
        await request(username);
        ms.push(performance.now() - t0);
      }
      return ms.sort((a, b) => a - b)[3]!; // median
    };
    const known = await samples(async () => (await h.makeUser('demo', { role: 'STUDENT' })).username);
    const unknown = await samples(async () => `GHOST-${h.run}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase());
    expect(Math.abs(known - unknown)).toBeLessThan(40);
    // The floor itself must be in force: a 40 ms tolerance alone can't see a small leak (same as M13).
    expect(Math.min(known, unknown)).toBeGreaterThanOrEqual(395);
  });

  it('[R15] confirm timing does not reveal whether an account exists', async () => {
    const samples = async (make: () => Promise<string>) => {
      const ms: number[] = [];
      for (let i = 0; i < 7; i++) {
        const username = await make();
        const t0 = performance.now();
        await confirm(username, '000000');
        ms.push(performance.now() - t0);
      }
      return ms.sort((a, b) => a - b)[3]!;
    };
    const known = await samples(async () => {
      const u = await h.makeUser('demo', { role: 'STUDENT' });
      await requestAndGetCode(u);
      return u.username;
    });
    const unknown = await samples(async () => `GHOST-${h.run}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase());
    expect(Math.abs(known - unknown)).toBeLessThan(40);
    // The floor itself must be in force: a 40 ms tolerance alone can't see a small leak (same as M13).
    expect(Math.min(known, unknown)).toBeGreaterThanOrEqual(395);
  });
});
