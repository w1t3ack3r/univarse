// Spec 0015 CI4/CI6: publish() is bounded and never throws, whatever it is given (owner review of #66).
// A fake Valkey client: no network.
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { CHANNELS, InvalidationBus } from './invalidation-bus.js';

const T = '0190a000-0000-7000-8000-00000000000a';
const bus = (publish: (c: string, m: string) => Promise<number>) => new InvalidationBus({ publish } as unknown as Redis, false);

describe('[CI4][CI6] InvalidationBus.publish never throws and is bounded', () => {
  it('[CI4] an invalid tenant id is reported as unconfirmed, never thrown, and nothing is sent', async () => {
    let sent = 0;
    const r = await bus(() => (sent++, Promise.resolve(1))).publish(CHANNELS.products, 'not-a-uuid');
    expect(r.delivered).toBe(false);
    expect(sent).toBe(0);
  });

  it('[CI6] a publisher that hangs is cut off at the timeout: unconfirmed', async () => {
    const started = Date.now();
    const r = await bus(() => new Promise<number>(() => undefined)).publish(CHANNELS.keysForget, T, 200);
    expect(r).toEqual({ delivered: false, reason: 'publish timed out' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('[CI4] a publisher that rejects is reported, not thrown; a delivered publish reports its receiver count', async () => {
    expect((await bus(() => Promise.reject(new Error('Connection is closed.'))).publish(CHANNELS.products, T)).delivered).toBe(false);
    expect(await bus(() => Promise.resolve(3)).publish(CHANNELS.products, T)).toEqual({ delivered: true, receivers: 3 });
  });
});
