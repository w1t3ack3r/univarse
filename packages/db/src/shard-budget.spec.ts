// Spec 0039 Q6 (Q-B3): the connection budget, as `stack:shards` and the console's Shards page both count it.
import { describe, expect, it } from 'vitest';
import { budgetLeft, dedicatedRoom, DEDICATED_POOL_SIZE, MINIMUM_READY, PLATFORM_POOLS } from './shard-budget.js';

describe('spec 0039 Q6: a server’s connection budget', () => {
  it('is max_connections less the reserved, the platform’s pools and every shard’s pool', () => {
    expect([PLATFORM_POOLS, DEDICATED_POOL_SIZE, MINIMUM_READY]).toEqual([30, 3, 2]);
    expect(budgetLeft({ maxConnections: 100, reservedConnections: 15, shardPoolSizes: [10] })).toBe(45);
    expect(budgetLeft({ maxConnections: 100, reservedConnections: 15, shardPoolSizes: [10, 3, 3] })).toBe(39);
  });

  it('holds whole dedicated databases only, and none when spent', () => {
    expect(dedicatedRoom(45)).toBe(15);
    expect(dedicatedRoom(5)).toBe(1);
    expect(dedicatedRoom(2)).toBe(0);
    expect(dedicatedRoom(-4)).toBe(0);
  });
});
