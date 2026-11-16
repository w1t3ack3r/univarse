import { describe, expect, it } from 'vitest';
import { clock, parseClockArgs } from './clock.js';
import type { JobRun } from './purge.js';

const run = (json: Record<string, unknown> | null, status: number | null = 0, error = ''): JobRun => ({ status, json, error });

describe('pnpm stack:clock (spec 0038 Q-D1–Q-D4)', () => {
  it('takes exactly `archive <slug> --confirm <the same slug>`', () => {
    expect(parseClockArgs(['archive', 'exit-test', '--confirm', 'exit-test'])).toEqual({ slug: 'exit-test' });
    for (const bad of [[], ['archive'], ['archive', 'exit-test'], ['archive', 'exit-test', '--confirm'], ['advance', 'exit-test', '--confirm', 'exit-test'], ['archive', '--confirm', '--confirm', '--confirm'], ['archive', 'exit-test', '--confirm', 'exit-test', '--solo']])
      expect(() => parseClockArgs(bad)).toThrow(/usage/);
    expect(() => parseClockArgs(['archive', 'exit-test', '--confirm', 'exit-tests'])).toThrow(/must repeat the slug exactly.*Nothing was changed/);
  });

  it('passes the slug twice to the job, and reports an archive with the days that were left', () => {
    const calls: (readonly string[])[] = [];
    const r = clock({ job: (a) => (calls.push(a), run({ ok: true, tenantId: 't1', archived: 'now', daysLeft: 61, sessionsEnded: true })) }, { slug: 'exit-test' });
    expect(calls).toEqual([['archive', 'exit-test', '--confirm', 'exit-test']]);
    expect(r).toEqual({ ok: true, lines: ["exit-test: archived now by the test clock, 61 days before its window's end; its sessions ended. The audit records it as a test-clock archive."] });
    expect(clock({ job: () => run({ ok: true, archived: 'now', daysLeft: 1, sessionsEnded: false }) }, { slug: 'x' }).lines[0]).toContain('1 day before');
  });

  it('says when it was already archived', () => {
    expect(clock({ job: () => run({ ok: true, archived: 'already', daysLeft: 0, sessionsEnded: false }) }, { slug: 'exit-test' })).toEqual({ ok: true, lines: ['exit-test: already archived; nothing else changed.'] });
  });

  it('fails on a refusal, in plain words, and on a job that failed', () => {
    const refused = clock({ job: () => run({ ok: false, refused: 'went_live' }, 3) }, { slug: 'live-uni' });
    expect(refused.ok).toBe(false);
    expect(refused.lines[0]).toMatch(/^live-uni: refused \(went_live\): it went live.*Nothing was changed\.$/);
    expect(clock({ job: () => run({ ok: false, refused: 'not_offboarding' }, 3) }, { slug: 'x' }).lines[0]).toContain('not in an offboarding window');
    expect(clock({ job: () => run({ ok: false, refused: 'no_tenant' }, 3) }, { slug: 'x' }).lines[0]).toContain('no institution has this slug');
    const failed = clock({ job: () => run(null, 1, 'connection refused') }, { slug: 'x' });
    expect(failed).toEqual({ ok: false, lines: ['x: the clock job failed (exit 1): connection refused. Run it again; it is safe to repeat.'] });
    // A job that exits 0 without saying it archived is a failure, never a success.
    expect(clock({ job: () => run({ ok: false, refused: 'went_live' }, 0) }, { slug: 'x' }).ok).toBe(false);
    expect(clock({ job: () => run(null, 0) }, { slug: 'x' }).ok).toBe(false);
  });
});
