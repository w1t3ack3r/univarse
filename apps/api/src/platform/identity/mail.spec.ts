// Spec 0028 Q4: the relay runs on a timer, outside any request, so a failed pass must never become an unhandled
// rejection: that kills the process. Seen on the stack (2026-11-06): 20 sign-ins at once held the pool, the relay's
// transaction gave up with P2028, and the platform API went down.
import type { PlatformClient } from '@univarse/db';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mailer } from '../../shared/infra/mailer.js';
import type { PlatformConfig } from '../platform-config.js';
import { PlatformMailRelay } from './mail.js';

const P2028 = Object.assign(new Error('Transaction API error: Unable to start a transaction in the given time.'), { code: 'P2028' });
const mailer: Mailer = { send: () => Promise.resolve() };
const config = { MAIL_RELAY_INTERVAL_MS: 1 } as PlatformConfig;
const noMail = (fn: (tx: { $queryRaw: () => Promise<unknown[]> }) => unknown) => Promise.resolve(fn({ $queryRaw: () => Promise.resolve([]) }));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

afterEach(() => vi.restoreAllMocks());

describe('[0028 Q4] the mail relay on its timer', () => {
  it('a failed pass is logged, not thrown, and the next tick tries again', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const $transaction = vi.fn().mockRejectedValueOnce(P2028).mockImplementation(noMail);
    const relay = new PlatformMailRelay({ $transaction } as unknown as PlatformClient, mailer, config);
    relay.onApplicationBootstrap();
    await until(() => $transaction.mock.calls.length >= 3);
    await relay.onApplicationShutdown();
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect($transaction.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'platform.mail.pass_failed', reason: 'P2028' });
  });

  it('shutting down during a failing pass still completes', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const $transaction = vi.fn().mockRejectedValue(P2028);
    const relay = new PlatformMailRelay({ $transaction } as unknown as PlatformClient, mailer, config);
    relay.onApplicationBootstrap();
    await until(() => $transaction.mock.calls.length >= 1);
    await expect(relay.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('a direct drain still reports its failure to the caller', async () => {
    const $transaction = vi.fn().mockRejectedValue(P2028);
    const relay = new PlatformMailRelay({ $transaction } as unknown as PlatformClient, mailer, { MAIL_RELAY_INTERVAL_MS: 0 } as PlatformConfig);
    await expect(relay.drain()).rejects.toBe(P2028);
  });
});
