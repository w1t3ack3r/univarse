// Spec 0039 Q11: the health pass's own rules, with a fake platform and registry.
import { describe, expect, it } from 'vitest';
import type { PlatformClient } from '@univarse/db';
import type { ShardRegistry } from './db.module.js';
import { SHARD_PROBE_TIMEOUT_MS, ShardHealthPass } from './shard-health.js';

type Probe = Awaited<ReturnType<ShardRegistry['probe']>>;

function fixture(results: Record<string, Probe>) {
  const upserts: {
    where: { shardId: string };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }[] = [];
  const asked: unknown[] = [];
  const probed: [string, number][] = [];
  const platform = {
    shard: {
      findMany: (args: unknown) => {
        asked.push(args);
        return Promise.resolve(Object.keys(results).map((id) => ({ id, name: `s-${id}` })));
      },
    },
    shardHealth: {
      upsert: (args: (typeof upserts)[number]) => {
        upserts.push(args);
        return Promise.resolve({ shardId: args.where.shardId });
      },
    },
  } as unknown as PlatformClient;
  const registry = {
    probe: (id: string, ms: number) => {
      probed.push([id, ms]);
      const r = results[id];
      return r ? Promise.resolve(r) : Promise.reject(new Error('unknown'));
    },
  } as unknown as ShardRegistry;
  return { pass: new ShardHealthPass(platform, registry), upserts, asked, probed };
}

const at = new Date('2026-11-25T10:00:00.000Z');

describe('spec 0039 Q11: the shard health pass', () => {
  it('checks every shard not retired, within the probe limit', async () => {
    const f = fixture({ a: { ok: true, latencyMs: 3 } });
    await f.pass.pass(() => at);
    expect(f.asked).toEqual([
      {
        where: { status: { not: 'RETIRED' } },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      },
    ]);
    expect(f.probed).toEqual([['a', SHARD_PROBE_TIMEOUT_MS]]);
  });

  it('a success records its latency and is the last success', async () => {
    const f = fixture({ a: { ok: true, latencyMs: 7 } });
    expect(await f.pass.pass(() => at)).toBe(0);
    const row = { checkedAt: at, ok: true, latencyMs: 7, lastSuccessAt: at, errorCode: null };
    expect(f.upserts).toEqual([
      {
        where: { shardId: 'a' },
        create: { shardId: 'a', ...row },
        update: row,
        select: { shardId: true },
      },
    ]);
  });

  it('a failure records its code and keeps the last success as it was', async () => {
    const f = fixture({ a: { ok: false, code: 'timeout' } });
    expect(await f.pass.pass(() => at)).toBe(1);
    const [u] = f.upserts;
    expect(u?.update).toEqual({ checkedAt: at, ok: false, latencyMs: null, errorCode: 'timeout' });
    expect(u?.update).not.toHaveProperty('lastSuccessAt');
    expect(u?.create).toMatchObject({ lastSuccessAt: null, errorCode: 'timeout' });
  });

  it('one shard failing never stops the others', async () => {
    const f = fixture({
      a: { ok: false, code: 'unreachable' },
      b: { ok: true, latencyMs: 1 },
      c: { ok: false, code: 'no_credentials' },
    });
    expect(await f.pass.pass(() => at)).toBe(2);
    expect(f.upserts.map((u) => [u.where.shardId, u.update.ok])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
  });
});
