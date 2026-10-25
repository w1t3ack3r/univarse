// Spec 0020 D6, BK8, B2-2: `status`, from inputs alone: every boundary, and what it says when a source can't be read.
import { describe, expect, it } from 'vitest';
import type { SetIndex, SetOnDisk } from './set.js';
import { age, statusReport, type StatusInputs } from './status.js';

const NOW = new Date('2026-10-25T12:00:00Z');
const H = 3600 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const set = (id: string, at: Date, complete = true): SetOnDisk => ({ setId: id, createdAt: at, index: complete ? ({ setId: id } as SetIndex) : null });
const base = (over: Partial<StatusInputs> = {}): StatusInputs => ({
  now: NOW,
  destination: '/backups',
  sets: [set('20261024T120000Z-aaaa', ago(24 * H)), set('20261025T060000Z-bbbb', ago(6 * H))],
  shipped: [{ name: '000000010000000000000011', at: ago(10 * 60_000) }],
  staged: [],
  schedule: [
    { name: 'backup', registered: true, lastRun: ago(6 * H), lastResult: 0 },
    { name: 'backup-wal', registered: true, lastRun: ago(5 * 60_000), lastResult: 0 },
  ],
  externalRule: null,
  waived: null,
  ...over,
});

describe('age', () => {
  it('reads at a glance at every scale', () => {
    expect(age(0)).toBe('0 min');
    expect(age(119 * 60_000)).toBe('119 min');
    expect(age(120 * 60_000)).toBe('2 h 0 min');
    expect(age(47 * H + 59 * 60_000)).toBe('47 h 59 min');
    expect(age(48 * H)).toBe('2 d 0 h');
    expect(age(35 * 24 * H + 5 * H)).toBe('35 d 5 h');
    expect(age(-5000)).toBe('0 min');
  });
});

describe('statusReport', () => {
  it('reports the newest set, the boundary from the OLDEST set, WAL and the schedule, with no warning when all is well', () => {
    const r = statusReport(base());
    expect(r).toEqual({
      ok: true,
      warnings: [],
      lines: [
        'destination: /backups',
        'newest set: 20261025T060000Z-bbbb, 6 h 0 min old',
        'erasure boundary: 24 h 0 min (the oldest of 2 retained sets, 20261024T120000Z-aaaa)',
        'WAL shipped: newest 000000010000000000000011, 10 min ago',
        'WAL staged: none waiting',
        'scheduled task backup: last run 6 h 0 min ago, result 0',
        'scheduled task backup-wal: last run 5 min ago, result 0',
      ],
    });
  });

  it('[BK8] warns only past 26 hours since the newest set, and when there is none', () => {
    const at = (ms: number) => statusReport(base({ sets: [set('20261024T100000Z-cccc', ago(ms))] })).warnings;
    expect(at(26 * H)).toEqual([]);
    expect(at(26 * H + 1)).toEqual([expect.stringMatching(/older than 26 hours/)]);
    expect(statusReport(base({ sets: [] })).warnings).toEqual([expect.stringMatching(/no complete backup set/)]);
    // An incomplete set is listed, never counted as the newest or the oldest.
    const r = statusReport(base({ sets: [set('20261020T000000Z-dddd', ago(5 * 24 * H), false), set('20261025T060000Z-bbbb', ago(6 * H))] }));
    expect(r.lines).toContain('erasure boundary: 6 h 0 min (the oldest of 1 retained set, 20261025T060000Z-bbbb)');
    expect(r.lines).toContain('incomplete sets (ignored; a prune removes them after a day): 20261020T000000Z-dddd');
  });

  it('[B-2] warns only once staged WAL has waited over an hour, naming the oldest', () => {
    const staged = (ms: number) => statusReport(base({ staged: [{ name: '000000010000000000000012', at: ago(5 * 60_000) }, { name: '000000010000000000000013', at: ago(ms) }] }));
    expect(staged(H).warnings).toEqual([]);
    expect(staged(H).lines).toContain('WAL staged: 2 waiting, the oldest 60 min');
    expect(staged(H + 1).warnings).toEqual([expect.stringMatching(/waited over 1 hour/)]);
    expect(statusReport(base({ shipped: [] })).lines).toContain('WAL shipped: none yet');
    const two = statusReport(base({ shipped: [{ name: '000000010000000000000012', at: ago(2 * 60_000) }, { name: '000000010000000000000011', at: ago(40 * 60_000) }] }));
    expect(two.lines).toContain('WAL shipped: newest 000000010000000000000012, 2 min ago');
  });

  it('[B2-4] warns on a task not registered or whose last run failed; a task not run yet is fine; not Windows, a note', () => {
    const r = statusReport(base({ schedule: [{ name: 'backup', registered: false }, { name: 'backup-wal', registered: true, lastRun: ago(60_000), lastResult: 1 }] }));
    expect(r.warnings).toEqual([expect.stringMatching(/backup is not registered.*schedule --at/), expect.stringMatching(/backup-wal's last run failed \(result 1\)/)]);
    expect(r.ok).toBe(true);
    const fresh = statusReport(base({ schedule: [{ name: 'backup', registered: true, lastRun: null, lastResult: null }] }));
    expect(fresh.warnings).toEqual([]);
    expect(fresh.lines).toContain('scheduled task backup: not run yet');
    // A failed result warns even when its run time couldn't be read.
    expect(statusReport(base({ schedule: [{ name: 'backup', registered: true, lastRun: null, lastResult: 2 }] })).warnings).toEqual([expect.stringMatching(/last run failed \(result 2\)/)]);
    expect(statusReport(base({ schedule: null })).lines).toContain('schedule: not on Windows (`pnpm stack:backup schedule` prints the crontab lines)');
  });

  it("[D7] warns when the external-drive rule doesn't hold; [BK17] reports a waiver", () => {
    expect(statusReport(base({ externalRule: 'the backup destination D:\\b is on another drive' })).warnings).toEqual(['the backup destination D:\\b is on another drive']);
    expect(statusReport(base({ waived: 'no-resurrection guarantee waived since 2026-10-01T00:00:00.000Z (generation 2)' })).lines.at(-1)).toBe(
      'no-resurrection guarantee waived since 2026-10-01T00:00:00.000Z (generation 2)',
    );
  });

  it("is not ok only when a source can't be read, and says which, without hiding the rest", () => {
    const r = statusReport(base({ sets: { problem: 'EACCES' }, staged: { problem: 'Docker is not running' }, schedule: { problem: 'PowerShell exited 1' }, waived: { problem: 'the primary is missing' } }));
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual([
      "the backup sets can't be read: EACCES",
      "the staged WAL can't be read: Docker is not running",
      "the scheduled tasks can't be read: PowerShell exited 1",
      "the shred ledger can't be read: the primary is missing",
    ]);
    expect(r.lines).toContain('WAL shipped: newest 000000010000000000000011, 10 min ago');
    expect(statusReport(base({ shipped: { problem: 'ENOENT' } })).ok).toBe(false);
    for (const one of [{ sets: { problem: 'EACCES' } }, { staged: { problem: 'x' } }, { schedule: { problem: 'x' } }, { waived: { problem: 'x' } }] as Partial<StatusInputs>[])
      expect([Object.keys(one)[0], statusReport(base(one)).ok]).toEqual([Object.keys(one)[0], false]);
  });
});
