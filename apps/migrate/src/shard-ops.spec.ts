// Spec 0039 Q5, Q6 (S8 PR B): the connection budget and the shards job's arguments.
import { describe, expect, it } from 'vitest';
import { budgetLeft, dedicatedRoom, DEDICATED_POOL_SIZE, MINIMUM_READY, PLATFORM_POOLS, readyWarning, retireProblem } from './shard-ops.js';
import { parseShardsArgs } from './shards-main.js';

describe('the connection budget (spec 0039 Q6)', () => {
  it('is the server’s connections less what is reserved, the platform’s pools and every shard’s pool', () => {
    // The stack: 100, 15 reserved, the platform's three roles at 10 each, pool-01 at 10.
    expect(PLATFORM_POOLS).toBe(30);
    expect(budgetLeft({ maxConnections: 100, reservedConnections: 15, shardPoolSizes: [10] })).toBe(45);
    expect(dedicatedRoom(45)).toBe(15);
    expect(budgetLeft({ maxConnections: 100, reservedConnections: 15, shardPoolSizes: [10, 3, 3] })).toBe(39);
    expect(dedicatedRoom(39)).toBe(13);
  });

  it('a budget below one dedicated pool holds none, and never a negative number', () => {
    expect(DEDICATED_POOL_SIZE).toBe(3);
    expect(dedicatedRoom(2)).toBe(0);
    expect(dedicatedRoom(-5)).toBe(0);
    expect(dedicatedRoom(3)).toBe(1);
  });
});

describe('the shards job’s arguments (spec 0039 PR B)', () => {
  it('reads each command exactly', () => {
    expect(parseShardsArgs(['ready'])).toEqual({ kind: 'ready', count: 1 });
    expect(parseShardsArgs(['ready', '--count', '3'])).toEqual({ kind: 'ready', count: 3 });
    expect(parseShardsArgs(['migrate', 'pool-01'])).toEqual({ kind: 'migrate', shard: 'pool-01' });
    expect(parseShardsArgs(['migrate', 't-abcdefgh1234', '--applied', '20261124120000_shards'])).toEqual({ kind: 'migrate', shard: 't-abcdefgh1234', resolve: { as: 'applied', migration: '20261124120000_shards' } });
    expect(parseShardsArgs(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234'])).toEqual({ kind: 'retire', shard: 't-abcdefgh1234', backupAfter: null });
    expect(parseShardsArgs(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234', '--backup-after', '2026-11-24T02:00:00.000Z'])).toEqual({
      kind: 'retire',
      shard: 't-abcdefgh1234',
      backupAfter: new Date('2026-11-24T02:00:00.000Z'),
    });
    expect(parseShardsArgs(['drill'])).toEqual({ kind: 'drill' });
    expect(parseShardsArgs(['list'])).toEqual({ kind: 'list' });
  });

  it('refuses anything else: counts out of range, a shard name that isn’t one, a confirmation that differs, extra words', () => {
    for (const bad of [
      [],
      ['ready', '--count', '0'],
      ['ready', '--count', '11'],
      ['ready', '--count', 'two'],
      ['migrate', 'univarse_platform'],
      ['migrate', 't-abcdefgh1234', '--applied'],
      ['migrate', 't-abcdefgh1234', '--guess', '20260930000000_init'],
      ['retire', 't-abcdefgh1234'],
      ['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1235'],
      ['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234', '--backup-after', 'yesterday'],
      ['drill', 'now'],
      ['drop', 'pool-01'],
    ])
      expect(parseShardsArgs(bad)).toBeNull();
  });
});

describe('retiring a dedicated database (spec 0039 Q13)', () => {
  const day = (d: number) => new Date(Date.UTC(2026, 10, d));
  it('is allowed with no institution, or every one purged and a newer backup set', () => {
    expect(retireProblem([], null)).toBeNull();
    expect(retireProblem([{ status: 'PURGED', purgedAt: day(20) }], day(21))).toBeNull();
    expect(retireProblem([{ status: 'PURGED', purgedAt: day(20) }, { status: 'PURGED', purgedAt: day(22) }], day(23))).toBeNull();
  });

  it('is refused while an institution there isn’t purged, a purge hasn’t finished, or no set is newer than the last purge', () => {
    expect(retireProblem([{ status: 'ARCHIVED', purgedAt: null }], day(30))).toMatch(/not purged/);
    expect(retireProblem([{ status: 'PURGED', purgedAt: null }], day(30))).toMatch(/has not finished/);
    expect(retireProblem([{ status: 'PURGED', purgedAt: day(20) }], null)).toMatch(/no backup set is newer/);
    expect(retireProblem([{ status: 'PURGED', purgedAt: day(20) }], day(20))).toMatch(/no backup set is newer/);
    // The newest purge counts, not the first.
    expect(retireProblem([{ status: 'PURGED', purgedAt: day(20) }, { status: 'PURGED', purgedAt: day(25) }], day(22))).toMatch(/no backup set is newer/);
  });
});

describe('ready dedicated databases (spec 0039 Q5)', () => {
  it('warns below 2, with the command that fixes it, and not at 2 or more', () => {
    expect(MINIMUM_READY).toBe(2);
    expect(readyWarning(0)).toBe('only 0 dedicated database(s) ready; keep 2: pnpm stack:shards ready --count 2');
    expect(readyWarning(1)).toMatch(/--count 1$/);
    expect(readyWarning(2)).toBeNull();
    expect(readyWarning(5)).toBeNull();
  });
});

