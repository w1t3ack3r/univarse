import { describe, expect, it } from 'vitest';
import { HEALTH_STALE_MS, POOL_NEARLY_FULL, shardWarnings, type ShardFacts } from './shards.js';

const now = new Date('2026-11-25T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const healthy = { ok: true, checkedAt: ago(30_000), errorCode: null, lastSuccessAt: ago(30_000) };
const shard = (over: Partial<ShardFacts> = {}): ShardFacts => ({
  id: 'id',
  name: 'pool-01',
  kind: 'POOL',
  status: 'ACTIVE',
  statusChangedAt: ago(86_400_000),
  held: 0,
  capacity: 50,
  runErrorCode: null,
  health: healthy,
  ...over,
});
const ready = (name: string) => shard({ name, kind: 'DEDICATED', status: 'READY', capacity: 1 });
const types = (s: readonly ShardFacts[], minimum = 2) => shardWarnings(s, minimum, now).map((w) => w.type);

describe('spec 0039 Q12: the Shards page’s warnings', () => {
  it('nothing to say: a healthy pool with room and enough ready databases', () => {
    expect(shardWarnings([shard(), ready('t-a'), ready('t-b')], 2, now)).toEqual([]);
  });

  it('a pool from 80% of its capacity is nearly full, and not below', () => {
    expect(POOL_NEARLY_FULL).toBe(0.8);
    expect(types([shard({ held: 39 }), ready('t-a'), ready('t-b')])).toEqual([]);
    expect(shardWarnings([shard({ held: 40 }), ready('t-a'), ready('t-b')], 2, now)).toEqual([{ type: 'pool_nearly_full', shard: 'pool-01', held: 40, capacity: 50 }]);
  });

  it('fewer than the minimum ready is low; the minimum itself is enough; a claimed one is not ready', () => {
    expect(shardWarnings([shard(), ready('t-a')], 2, now)).toEqual([{ type: 'ready_low', ready: 1, minimum: 2 }]);
    expect(types([shard(), ready('t-a'), ready('t-b')])).toEqual([]);
    expect(types([shard(), ready('t-a'), shard({ name: 't-b', kind: 'DEDICATED', status: 'ACTIVE', capacity: 1, held: 1 })])).toEqual(['ready_low']);
  });

  it('a shard in maintenance warns with its run’s code and since when', () => {
    const since = ago(600_000);
    expect(shardWarnings([shard({ status: 'MAINTENANCE', statusChangedAt: since, runErrorCode: 'migrate_failed' }), ready('t-a'), ready('t-b')], 2, now)).toEqual([
      { type: 'maintenance', shard: 'pool-01', errorCode: 'migrate_failed', since },
    ]);
  });

  it('an unreachable shard warns with its code and its last success', () => {
    const last = ago(900_000);
    expect(shardWarnings([shard({ health: { ok: false, checkedAt: ago(20_000), errorCode: 'timeout', lastSuccessAt: last } }), ready('t-a'), ready('t-b')], 2, now)).toEqual([
      { type: 'unreachable', shard: 'pool-01', errorCode: 'timeout', lastSuccessAt: last },
    ]);
  });

  it('a shard never checked, or not checked for three passes, is unchecked (whatever its last answer)', () => {
    expect(HEALTH_STALE_MS).toBe(180_000);
    expect(types([shard({ health: null }), ready('t-a'), ready('t-b')])).toEqual(['unchecked']);
    expect(types([shard({ health: { ...healthy, checkedAt: ago(HEALTH_STALE_MS) } }), ready('t-a'), ready('t-b')])).toEqual([]);
    expect(types([shard({ health: { ok: false, checkedAt: ago(HEALTH_STALE_MS + 1), errorCode: 'timeout', lastSuccessAt: null } }), ready('t-a'), ready('t-b')])).toEqual(['unchecked']);
  });

  it('a retired shard never warns, and is never counted as ready', () => {
    expect(types([shard({ status: 'RETIRED', held: 50, health: null }), shard({ name: 'pool-02' }), ready('t-a'), ready('t-b')])).toEqual([]);
    expect(types([shard(), ready('t-a'), shard({ name: 't-b', kind: 'DEDICATED', status: 'RETIRED', capacity: 1 })])).toEqual(['ready_low']);
  });

  it('what stops institutions comes first: maintenance, then reach, then readiness, then room', () => {
    const all = [shard({ held: 45, health: null }), shard({ name: 'pool-02', status: 'MAINTENANCE', runErrorCode: 'rls_failed' })];
    expect(types(all)).toEqual(['maintenance', 'unchecked', 'ready_low', 'pool_nearly_full']);
  });
});
