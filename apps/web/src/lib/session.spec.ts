import { beforeEach, describe, expect, it, vi } from 'vitest';

// redirect() throws in Next.js; the stand-in throws too, so control flow matches.
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
// A plain stub, not vi.fn(): a mock records the promises it returns, and vitest reports a recorded
// rejection as a failure even though the code under test handled it.
let answer: () => Promise<unknown> = () => Promise.resolve(undefined);
vi.mock('./server-api', () => ({ serverApi: () => answer() }));
const respond = (value: unknown) => {
  answer = () => Promise.resolve(value);
};

const { requireSession } = await import('./session');
const { ApiUnavailableError } = await import('./session-check');

const me = { id: 'u1', username: 'ADA', displayName: 'Ada', mfa: true, restricted: false, permissions: [] };

describe('[W7] requireSession', () => {
  beforeEach(() => respond(undefined));

  it('returns the user for a valid session', async () => {
    respond({ status: 200, body: me, requestId: 'req-00000001' });
    await expect(requireSession()).resolves.toEqual(me);
  });

  it('redirects to login on 401', async () => {
    respond({ status: 401, body: { code: 'auth.unauthenticated' }, requestId: 'req-00000001' });
    await expect(requireSession()).rejects.toThrow('redirect:/login');
  });

  it('sends a restricted session to two-step setup', async () => {
    respond({ status: 200, body: { ...me, restricted: true }, requestId: 'req-00000001' });
    await expect(requireSession()).rejects.toThrow('redirect:/mfa/setup');
  });

  it('throws to the error boundary on a 500 — the 2026-10-05 W12 flake (Prisma P2028) — keeping the reference', async () => {
    respond({ status: 500, body: { code: 'server.internal', requestId: 'req-00000500' }, requestId: 'req-00000500' });
    const err = await requireSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiUnavailableError);
    expect(err).toMatchObject({ code: 'server.internal', requestId: 'req-00000500' });
  });

  it('throws to the error boundary when the API cannot be reached', async () => {
    answer = () => Promise.reject(new TypeError('fetch failed'));
    await expect(requireSession()).rejects.toMatchObject({ code: 'network.unreachable' });
  });
});
