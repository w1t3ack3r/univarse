// Spec 0023 T2: the services' own token renewal, with a fake fetch and fake timers. It renews at start and on its
// interval, logs each outcome without the token, and never throws into the app.
import { describe, expect, it } from 'vitest';
import { RENEW_EVERY_MS, VaultTokenRenewer, type RenewerLog } from './token-renewal.js';

const TOKEN = 'hvs.SECRETSECRETSECRET';
interface Logged {
  readonly level: 'info' | 'warn' | 'error';
  readonly o: Record<string, unknown>;
  readonly msg: string;
}
function harness(answer: () => Promise<Response> | Response) {
  const logged: Logged[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const log: RenewerLog = {
    info: (event, fields, msg) => void logged.push({ level: 'info', o: { event, ...fields }, msg }),
    warn: (event, fields, msg) => void logged.push({ level: 'warn', o: { event, ...fields }, msg }),
    error: (event, fields, msg) => void logged.push({ level: 'error', o: { event, ...fields }, msg }),
  };
  const timers: { f: () => void; ms: number; unrefd: boolean }[] = [];
  let cleared = 0;
  const r = new VaultTokenRenewer({
    addr: 'https://vault:8200/',
    token: TOKEN,
    log,
    fetch: ((url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(answer());
    }) as unknown as typeof fetch,
    setInterval: (f, ms) => {
      const t = { f, ms, unrefd: false };
      timers.push(t);
      return { unref: () => (t.unrefd = true) };
    },
    clearInterval: () => {
      cleared++;
    },
  });
  return { r, logged, requests, timers, cleared: () => cleared };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = () => new Promise((res) => setTimeout(res, 0));
/** Nothing the renewer logs holds the token. */
const tokenless = (logged: readonly Logged[]) => expect(JSON.stringify(logged)).not.toContain(TOKEN);

describe('[0023 T2] VaultTokenRenewer', () => {
  it('renews itself: renew-self, the token in its header only, no increment; logs the new TTL', async () => {
    const h = harness(() => json(200, { auth: { lease_duration: 2764800 } }));
    expect(await h.r.tick()).toEqual({ kind: 'renewed', ttlSeconds: 2764800 });
    expect(h.requests).toHaveLength(1);
    const [req] = h.requests;
    expect(req?.url).toBe('https://vault:8200/v1/auth/token/renew-self');
    expect(req?.init.method).toBe('POST');
    expect((req?.init.headers as Record<string, string>)['x-vault-token']).toBe(TOKEN);
    expect(req?.init.body).toBe('{}');
    expect(req?.url).not.toContain(TOKEN);
    expect(h.logged).toEqual([{ level: 'info', o: { event: 'vault.token.renewed', ttlSeconds: 2764800 }, msg: 'Vault token renewed' }]);
  });

  it('start renews at once, then every 6 hours, on a timer that never keeps the process alive; stop clears it', async () => {
    const h = harness(() => json(200, { auth: { lease_duration: 100 } }));
    h.r.start();
    await flush();
    expect(h.requests).toHaveLength(1);
    expect(h.timers).toEqual([expect.objectContaining({ ms: RENEW_EVERY_MS, unrefd: true })]);
    expect(RENEW_EVERY_MS).toBe(6 * 3600 * 1000);
    h.timers[0]?.f();
    await flush();
    expect(h.requests).toHaveLength(2);
    h.r.start(); // a second start is ignored
    expect(h.timers).toHaveLength(1);
    h.r.stop();
    expect(h.cleared()).toBe(1);
  });

  it("a refused renewal (403, or 400: the token is dead) is logged as an error that names the deploy; nothing's thrown", async () => {
    for (const status of [403, 400]) {
      const h = harness(() => json(status, { errors: ['permission denied'] }));
      expect(await h.r.tick()).toEqual({ kind: 'refused', status });
      expect(h.logged).toEqual([expect.objectContaining({ level: 'error', o: { event: 'vault.token.renew_refused', status } })]);
      expect(h.logged[0]?.msg).toMatch(/pnpm stack:deploy/);
      tokenless(h.logged);
    }
  });

  it('a sealed Vault (503) is a warning that names the unseal, not a dead token', async () => {
    const h = harness(() => json(503, { errors: ['Vault is sealed'] }));
    expect(await h.r.tick()).toEqual({ kind: 'sealed' });
    expect(h.logged).toEqual([expect.objectContaining({ level: 'warn', o: { event: 'vault.token.renew_failed', reason: 'sealed' } })]);
    expect(h.logged[0]?.msg).toMatch(/pnpm stack:vault unseal/);
  });

  it('a 500, a network error or an unreadable answer is a warning, retried at the next tick; never thrown', async () => {
    const cases: [() => Promise<Response> | Response, string][] = [
      [() => json(500, {}), 'HTTP 500'],
      [() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'ECONNREFUSED'],
      [() => new Response('not json', { status: 200 }), 'unreadable response'],
      [() => json(200, { auth: {} }), 'no lease_duration'],
    ];
    for (const [answer, reason] of cases) {
      const h = harness(answer);
      await expect(h.r.tick()).resolves.toEqual({ kind: 'failed', detail: reason });
      expect(h.logged).toEqual([expect.objectContaining({ level: 'warn', o: { event: 'vault.token.renew_failed', reason } })]);
      tokenless(h.logged);
    }
  });

  it('a failure on the timer never escapes into the process', async () => {
    const h = harness(() => Promise.reject(new Error('boom')));
    h.r.start();
    h.timers[0]?.f();
    await flush();
    expect(h.logged.every((l) => l.level === 'warn')).toBe(true);
    h.r.stop();
  });
});
