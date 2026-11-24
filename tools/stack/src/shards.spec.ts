import { describe, expect, it } from 'vitest';
import type { SetOnDisk } from './backup/set.js';
import type { JobRun } from './purge.js';
import { jobArgs, newestComplete, report, shards } from './shards.js';

const run = (json: Record<string, unknown> | null, status: number | null = 0, error = ''): JobRun => ({ status, json, error });
const SET = new Date('2026-11-24T02:00:00Z');
const set = (iso: string, complete = true): SetOnDisk => ({ setId: 'x', createdAt: new Date(iso), index: complete ? ({} as SetOnDisk['index']) : null });

describe('pnpm stack:shards (spec 0039 PR B)', () => {
  it('passes ready, migrate, drill and list through; retire needs its name twice and gains the newest set’s time', () => {
    const none = () => null;
    expect(jobArgs(['ready', '--count', '2'], none)).toEqual(['ready', '--count', '2']);
    expect(jobArgs(['migrate', 't-abcdefgh1234', '--rolled-back', '20260930000000_init'], none)).toEqual(['migrate', 't-abcdefgh1234', '--rolled-back', '20260930000000_init']);
    expect(jobArgs(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234'], () => SET)).toEqual(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234', '--backup-after', SET.toISOString()]);
    expect(jobArgs(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234'], none)).toEqual(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234']);
    expect(() => jobArgs(['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1235'], none)).toThrow(/must repeat the shard's name exactly.*Nothing was changed/);
    for (const bad of [[], ['drop'], ['retire', 't-abcdefgh1234'], ['retire', 'univarse_platform', '--confirm', 'univarse_platform']]) expect(() => jobArgs(bad, none)).toThrow(/usage/);
  });

  it('the newest set is the newest complete one', () => {
    expect(newestComplete([set('2026-11-20T02:00:00Z'), set('2026-11-24T02:00:00Z'), set('2026-11-25T02:00:00Z', false)])?.toISOString()).toBe(SET.toISOString());
    expect(newestComplete([])).toBeNull();
  });

  it('ready: ok only when every database is ready and reachable through PgBouncer', () => {
    const good = { name: 't-a', database: 'univarse_t_a', status: 'READY', code: null, reachable: true };
    expect(report('ready', run({ ok: true, made: [good] }))).toEqual({ ok: true, lines: ['t-a (univarse_t_a): ready, migrated, and reachable through PgBouncer as the app.'] });
    expect(report('ready', run({ ok: true, made: [good, { ...good, reachable: false }] })).ok).toBe(false);
    const failed = report('ready', run({ ok: true, made: [{ ...good, status: 'MAINTENANCE', code: 'migrate_failed', reachable: false }] }));
    expect(failed.ok).toBe(false);
    expect(failed.lines[0]).toMatch(/FAILED \(migrate_failed\); it is in maintenance/);
    expect(report('ready', run({ ok: true, made: [] })).ok).toBe(false);
  });

  it('migrate, retire and drill say what happened; a refusal and a failed job are failures, in plain words', () => {
    expect(report('migrate', run({ ok: true, migrated: true, code: null })).ok).toBe(true);
    expect(report('migrate', run({ ok: true, migrated: false, code: 'rls_failed' }))).toEqual({ ok: false, lines: ['its migration FAILED (rls_failed); it stays in maintenance. See the runbook in docs/10 §4.'] });
    expect(report('retire', run({ ok: true, database: 'univarse_t_a', institutions: 1 })).lines[0]).toMatch(/univarse_t_a is dropped and the shard is retired/);
    expect(report('drill', run({ ok: true, name: 't-a', failedWith: 'migrate_failed', recovered: true })).ok).toBe(true);
    expect(report('drill', run({ ok: true, name: 't-a', failedWith: null, recovered: false })).ok).toBe(false);
    expect(report('drill', run({ ok: true, name: 't-a', failedWith: 'migrate_failed', recovered: false })).ok).toBe(false);
    expect(report('retire', run({ ok: false, refused: 'an institution on it is not purged' }, 3))).toEqual({ ok: false, lines: ['refused: an institution on it is not purged. Nothing was changed.'] });
    expect(report('list', run(null, 1, 'connection refused'))).toEqual({ ok: false, lines: ['the shards job failed (exit 1): connection refused'] });
    // Exit 0 without saying ok is a failure, never a success.
    expect(report('migrate', run({ ok: false, refused: 'x' }, 0)).ok).toBe(false);
  });

  it('list warns when fewer than 2 dedicated databases are ready', () => {
    const listed = (ready: number) => run({ ok: true, server: 'local', left: 39, room: 13, ready, shards: [{ name: 'pool-01', kind: 'POOL', status: 'ACTIVE', institutions: 3, lastRun: 'SUCCEEDED' }] });
    expect(report('list', listed(1)).lines.at(-1)).toMatch(/WARN only 1 dedicated database\(s\) ready; keep 2: pnpm stack:shards ready --count 1/);
    expect(report('list', listed(2)).lines.some((l) => l.startsWith('WARN'))).toBe(false);
    expect(report('list', listed(2)).lines[0]).toBe('server local: 39 connection(s) left, room for 13 more dedicated database(s)');
  });

  it('runs the job with the arguments it built', () => {
    const calls: (readonly string[])[] = [];
    const r = shards({ job: (a) => (calls.push(a), run({ ok: true, database: 'univarse_t_a', institutions: 0 })), newestSet: () => SET }, ['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234']);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['retire', 't-abcdefgh1234', '--confirm', 't-abcdefgh1234', '--backup-after', SET.toISOString()]]);
  });
});
