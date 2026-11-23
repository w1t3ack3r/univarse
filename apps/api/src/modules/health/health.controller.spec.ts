// Spec 0039 Q10: readiness needs the platform and, when one is ACTIVE, a reachable tenant shard. With every shard in
// maintenance the API is still ready (answering 503 for them is its job then); with no shard at all, it isn't.
import type { PlatformClient } from '@univarse/db';
import { describe, expect, it } from 'vitest';
import type { ShardRegistry } from '../../shared/db/db.module.js';
import { HealthController } from './health.controller.js';

function controller(shards: { id: string; status: string }[], opts: { shardDown?: boolean } = {}) {
  const opened: string[] = [];
  const platform = {
    $queryRaw: () => Promise.resolve([{ '?column?': 1 }]),
    shard: { findMany: ({ where }: { where: { status: { in: string[] } } }) => Promise.resolve(shards.filter((s) => where.status.in.includes(s.status))) },
  } as unknown as PlatformClient;
  const registry = {
    client: (id: string) => {
      opened.push(id);
      return Promise.resolve({ $queryRaw: () => (opts.shardDown ? Promise.reject(new Error('down')) : Promise.resolve([])) });
    },
  } as unknown as ShardRegistry;
  return { c: new HealthController(platform, registry), opened };
}

describe('readiness (spec 0039 Q10)', () => {
  it('is ready with an ACTIVE shard it can reach, and checks that one, not one in maintenance', async () => {
    const { c, opened } = controller([
      { id: 'm', status: 'MAINTENANCE' },
      { id: 'a', status: 'ACTIVE' },
    ]);
    expect(await c.ready()).toEqual({ status: 'ready' });
    expect(opened).toEqual(['a']);
  });

  it('is still ready when every shard is in maintenance: their 503 is the answer it serves', async () => {
    const { c, opened } = controller([{ id: 'm', status: 'MAINTENANCE' }]);
    expect(await c.ready()).toEqual({ status: 'ready' });
    expect(opened).toEqual([]);
  });

  it('is not ready with no shard at all, or with its ACTIVE shard unreachable', async () => {
    await expect(controller([]).c.ready()).rejects.toMatchObject({ status: 503 });
    await expect(controller([{ id: 'r', status: 'RETIRED' }]).c.ready()).rejects.toMatchObject({ status: 503 });
    await expect(controller([{ id: 'a', status: 'ACTIVE' }], { shardDown: true }).c.ready()).rejects.toMatchObject({ status: 503 });
  });
});
