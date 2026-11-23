// Spec 0039 Q8, Q9: the tenant migrations run per shard, each recorded; one shard's failure puts it in maintenance and
// never stops the next; a success returns a shard in maintenance to service.
import { describe, expect, it } from 'vitest';
import { migrateShards, newlyApplied, statusAfterSuccess, type RunOutcome, type ShardStatus, type ShardSteps, type ShardToMigrate } from './shards.js';

const shard = (name: string, over: Partial<ShardToMigrate> = {}): ShardToMigrate => ({
  id: `id-${name}`,
  name,
  kind: 'POOL',
  database: `univarse_${name.replace('-', '_')}`,
  status: 'ACTIVE',
  hasTenant: true,
  ...over,
});

interface World {
  shards: ShardToMigrate[];
  /** Per shard name: what goes wrong. */
  fail?: Record<string, 'no_url' | 'unreachable' | 'migrate' | 'rls' | 'throws'>;
  /** Migrations each database has before, and what deploy adds. */
  before?: string[];
  adds?: string[];
}

function run(w: World) {
  const runs: { shard: string; outcome?: RunOutcome }[] = [];
  const statuses: [string, ShardStatus][] = [];
  const migrated: string[] = [];
  const applied = new Map<string, string[]>();
  const nameOf = (url: string) => url.replace('url:', '');
  const steps: ShardSteps = {
    listShards: () => Promise.resolve(w.shards),
    migratorUrl: (s) => (w.fail?.[s.name] === 'no_url' ? null : `url:${s.name}`),
    startRun: (s) => {
      runs.push({ shard: s.name });
      return Promise.resolve(String(runs.length - 1));
    },
    finishRun: (id, outcome) => {
      const r = runs[Number(id)];
      if (r) r.outcome = outcome;
      return Promise.resolve();
    },
    applied: (url) => {
      const name = nameOf(url);
      if (w.fail?.[name] === 'unreachable') return Promise.resolve('unreachable');
      if (w.fail?.[name] === 'throws') return Promise.reject(new Error('boom'));
      return Promise.resolve(applied.get(name) ?? w.before ?? ['m1']);
    },
    migrate: (url) => {
      const name = nameOf(url);
      migrated.push(name);
      // A failing deploy may still have applied some migrations before the one that failed.
      applied.set(name, [...(w.before ?? ['m1']), ...(w.adds ?? []).slice(0, w.fail?.[name] === 'migrate' ? 1 : undefined)]);
      return w.fail?.[name] === 'migrate' ? Promise.reject(new Error('deploy failed')) : Promise.resolve();
    },
    rlsCheck: (url) => Promise.resolve(w.fail?.[nameOf(url)] === 'rls' ? ['t: row level security not FORCED'] : []),
    setStatus: (id, status) => {
      statuses.push([id.replace('id-', ''), status]);
      return Promise.resolve();
    },
    log: () => undefined,
  };
  return { steps, runs, statuses, migrated };
}

describe('the per-shard runner (spec 0039 Q9)', () => {
  it('migrates every shard in the order listed, each recorded with what it applied', async () => {
    const w = run({ shards: [shard('pool-01'), shard('t-a', { kind: 'DEDICATED', status: 'READY', hasTenant: false })], before: ['m1'], adds: ['m2', 'm3'] });
    expect(await migrateShards(w.steps)).toEqual({ migrated: ['pool-01', 't-a'], failed: [] });
    expect(w.migrated).toEqual(['pool-01', 't-a']);
    expect(w.runs).toEqual([
      { shard: 'pool-01', outcome: { status: 'SUCCEEDED', applied: 2, lastMigration: 'm3' } },
      { shard: 't-a', outcome: { status: 'SUCCEEDED', applied: 2, lastMigration: 'm3' } },
    ]);
    expect(w.statuses).toEqual([]);
  });

  it('a failure puts that shard in maintenance and goes on to the next', async () => {
    const w = run({ shards: [shard('pool-01'), shard('pool-02'), shard('pool-03')], fail: { 'pool-02': 'migrate' }, adds: ['m2', 'm3'] });
    expect(await migrateShards(w.steps)).toEqual({ migrated: ['pool-01', 'pool-03'], failed: [{ name: 'pool-02', code: 'migrate_failed' }] });
    expect(w.migrated).toEqual(['pool-01', 'pool-02', 'pool-03']);
    expect(w.statuses).toEqual([['pool-02', 'MAINTENANCE']]);
    // What it applied before the failure is recorded.
    expect(w.runs[1]?.outcome).toEqual({ status: 'FAILED', code: 'migrate_failed', applied: 1, lastMigration: 'm2' });
  });

  it('each failure has its fixed code: no URL, unreachable, rls:check, and anything unexpected', async () => {
    const w = run({
      shards: [shard('a'), shard('b'), shard('c'), shard('d')],
      fail: { a: 'no_url', b: 'unreachable', c: 'rls', d: 'throws' },
    });
    const r = await migrateShards(w.steps);
    expect(r.failed).toEqual([
      { name: 'a', code: 'no_credentials' },
      { name: 'b', code: 'unreachable' },
      { name: 'c', code: 'rls_failed' },
      { name: 'd', code: 'unexpected' },
    ]);
    // Nothing was deployed where there was no URL or no connection.
    expect(w.migrated).toEqual(['c']);
    expect(w.statuses.map(([, s]) => s)).toEqual(['MAINTENANCE', 'MAINTENANCE', 'MAINTENANCE', 'MAINTENANCE']);
  });

  it('a shard already in maintenance that fails again stays there, without a second status write', async () => {
    const w = run({ shards: [shard('pool-01', { status: 'MAINTENANCE' })], fail: { 'pool-01': 'migrate' } });
    expect((await migrateShards(w.steps)).failed).toEqual([{ name: 'pool-01', code: 'migrate_failed' }]);
    expect(w.statuses).toEqual([]);
  });

  it('a success returns a shard in maintenance: a pool or a claimed dedicated one to ACTIVE, an unclaimed one to READY', async () => {
    const w = run({
      shards: [
        shard('pool-01', { status: 'MAINTENANCE' }),
        shard('t-claimed', { kind: 'DEDICATED', status: 'MAINTENANCE', hasTenant: true }),
        shard('t-ready', { kind: 'DEDICATED', status: 'MAINTENANCE', hasTenant: false }),
      ],
    });
    await migrateShards(w.steps);
    expect(w.statuses).toEqual([
      ['pool-01', 'ACTIVE'],
      ['t-claimed', 'ACTIVE'],
      ['t-ready', 'READY'],
    ]);
  });

  it('statusAfterSuccess leaves a shard that wasn’t in maintenance as it was', () => {
    for (const status of ['ACTIVE', 'READY'] as const) expect(statusAfterSuccess({ kind: 'DEDICATED', status, hasTenant: false })).toBe(status);
  });

  it('newlyApplied keeps the order and only what is new', () => {
    expect(newlyApplied(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'd']);
    expect(newlyApplied([], ['a'])).toEqual(['a']);
    expect(newlyApplied(['a'], ['a'])).toEqual([]);
  });
});
