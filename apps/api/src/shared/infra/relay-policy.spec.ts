// Spec 0016 IO11/IO18: the relay's pure rules. No database, no Valkey.
import { describe, expect, it } from 'vitest';
import { CHANNELS, PUBLISH_TIMEOUT_MS } from './invalidation-bus.js';
import {
  classifyFailure,
  coalesce,
  failureLabel,
  publishBudgetMs,
  relayBackoffMs,
  type ClaimedEvent,
} from './relay-policy.js';

const A = '0190a000-0000-7000-8000-00000000000a';
const B = '0190a000-0000-7000-8000-00000000000b';
let seq = 0;
const ev = (channel: string, tenantId: string): ClaimedEvent => ({
  id: `e${String(++seq)}`,
  channel,
  tenantId,
  attempts: 0,
});

describe('[IO11][IO18] coalescing groups by (channel, tenant) within one batch only', () => {
  it('[IO11][IO18] the same tenant on both channels yields two publishes; repeats within a batch collapse', () => {
    const batch = [
      ev(CHANNELS.products, A),
      ev(CHANNELS.tenants, A),
      ev(CHANNELS.products, A),
      ev(CHANNELS.products, B),
    ];
    const pubs = coalesce(batch);
    expect(pubs.map((p) => [p.channel, p.tenantId])).toEqual([
      [CHANNELS.products, A],
      [CHANNELS.tenants, A],
      [CHANNELS.products, B],
    ]);
    // Every event is settled by exactly one publish, oldest pair first.
    expect(pubs[0]?.eventIds).toEqual([batch[0]?.id, batch[2]?.id]);
    expect(pubs.flatMap((p) => p.eventIds).sort()).toEqual(batch.map((e) => e.id).sort());
  });

  it('[IO11] a tenant recurring in the next batch yields another publish', () => {
    expect(coalesce([ev(CHANNELS.products, A)])).toHaveLength(1);
    expect(coalesce([ev(CHANNELS.products, A)])).toHaveLength(1);
  });

  it('[IO11] a batch never yields more publishes than events', () => {
    for (let n = 0; n < 30; n++) {
      const batch = Array.from({ length: n }, (_, i) =>
        ev(i % 3 ? CHANNELS.products : CHANNELS.tenants, i % 2 ? A : B),
      );
      expect(coalesce(batch).length).toBeLessThanOrEqual(batch.length);
    }
  });
});

describe('[IO11] the publish budget and what running out of time means', () => {
  it('[IO11] each publish gets min(5 s, time left before the deadline)', () => {
    expect(publishBudgetMs(10_000, 0)).toBe(PUBLISH_TIMEOUT_MS);
    expect(publishBudgetMs(2_000, 1_700)).toBe(300);
    expect(publishBudgetMs(2_000, 2_000)).toBe(0);
  });

  it('[IO11] a timeout on a clipped budget is deadline exhaustion; on the full budget, or Valkey unavailable, a failure', () => {
    expect(classifyFailure('publish timed out', 300)).toBe('deadline');
    expect(classifyFailure('publish timed out', PUBLISH_TIMEOUT_MS)).toBe('failure');
    expect(
      classifyFailure("Stream isn't writeable and enableOfflineQueue options is false", 300),
    ).toBe('failure');
  });

  it('[IO11] last_error holds a fixed class, never the client message', () => {
    expect(failureLabel('publish timed out')).toBe('PublishTimeout');
    expect(failureLabel('connect ECONNREFUSED 127.0.0.1:6379')).toBe('PublishFailed');
  });

  it('[IO11] backoff: 250 ms doubling, ±20 % jitter, never above 5 s', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 10].map((n) => relayBackoffMs(n, mid))).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
    expect(relayBackoffMs(1, () => 0)).toBe(200);
    expect(relayBackoffMs(1, () => 1)).toBe(300);
    expect(relayBackoffMs(20, () => 1)).toBe(5_000);
  });
});
