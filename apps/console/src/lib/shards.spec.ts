import { describe, expect, it } from 'vitest';
import { healthText, runText, warningText } from './shards';

const at = '2026-11-25T10:00:00.000Z';

describe('shards in the console (spec 0039 Q12)', () => {
  it('says a migration run plainly, its failure by its code', () => {
    expect(runText(null)).toBe('No migration run recorded');
    expect(runText({ status: 'FAILED', applied: 0, lastMigration: null, errorCode: 'migrate_failed', startedAt: at, finishedAt: at })).toMatch(/^Failed .*: a migration failed part-way$/);
    expect(runText({ status: 'SUCCEEDED', applied: 3, lastMigration: 'x', errorCode: null, startedAt: at, finishedAt: at })).toMatch(/, 3 applied$/);
  });

  it('says a health check plainly, and never calls a stale one healthy', () => {
    expect(healthText(null, true)).toEqual({ text: 'Not checked yet', tone: 'pc-status--wait' });
    expect(healthText({ ok: true, latencyMs: 4, errorCode: null, checkedAt: at, lastSuccessAt: at }, false)).toEqual({ text: 'Answering, 4 ms', tone: 'pc-status--on' });
    expect(healthText({ ok: true, latencyMs: 4, errorCode: null, checkedAt: at, lastSuccessAt: at }, true).tone).toBe('pc-status--wait');
    expect(healthText({ ok: false, latencyMs: null, errorCode: 'timeout', checkedAt: at, lastSuccessAt: null }, false)).toEqual({ text: 'Not answering: it took longer than 5 seconds to answer', tone: 'pc-status--bad' });
  });

  it('says each warning with what to do, the command included where there is one', () => {
    expect(warningText({ type: 'ready_low', ready: 0, minimum: 2 })).toEqual({
      title: 'No dedicated database is ready; keep 2',
      todo: 'A dedicated institution can’t be created without one. Run pnpm stack:shards ready --count 2 on the host.',
    });
    expect(warningText({ type: 'ready_low', ready: 1, minimum: 2 }).title).toBe('Only 1 dedicated database is ready; keep 2');
    expect(warningText({ type: 'maintenance', shard: 't-abc', errorCode: 'rls_failed', since: at }).todo).toMatch(/pnpm stack:shards migrate t-abc\.$/);
    expect(warningText({ type: 'pool_nearly_full', shard: 'pool-01', held: 41, capacity: 50 }).title).toBe('pool-01 holds 41 of its 50 institutions');
    expect(warningText({ type: 'unreachable', shard: 'pool-01', errorCode: 'timeout', lastSuccessAt: null }).todo).toMatch(/^It has never answered\./);
    expect(warningText({ type: 'unchecked', shard: 'pool-01', checkedAt: null }).title).toBe('pool-01 hasn’t been checked yet');
  });
});
