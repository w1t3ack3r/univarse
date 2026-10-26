// Spec 0020 B-12, B2-11: the drill's four steps in order, stopping at the first failure.
import { describe, expect, it } from 'vitest';
import { drill, drillSlug, type DrillDeps } from './drill.js';

const NOW = new Date('2026-10-26T09:00:00Z');
function scripted(over: Partial<DrillDeps> = {}) {
  const calls: string[] = [];
  const deps: DrillDeps = {
    log: () => undefined,
    createTenant: (s) => (calls.push(`create:${s}`), { ok: true, tenantId: 't-id', keyVersion: 1, values: 3 }),
    backup: () => (calls.push('backup'), Promise.resolve({ ok: true, setId: '20261026T090100Z-ab12' })),
    destroy: (s) => (calls.push(`destroy:${s}`), Promise.resolve({ ok: true, op: 'op-1' })),
    rehearse: (set, d) => (calls.push(`rehearse:${set}:${d}`), Promise.resolve({ ok: true, lines: ['every check passed'], record: null })),
    ...over,
  };
  return { deps, calls };
}

describe('[B2-11] the drill', () => {
  it('a tenant named for the day, then the backup, then its destruction, then the rehearsal of that very set', async () => {
    expect(drillSlug(NOW)).toBe('shred-drill-20261026');
    const { deps, calls } = scripted();
    const r = await drill(NOW, deps);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['create:shred-drill-20261026', 'backup', 'destroy:shred-drill-20261026', 'rehearse:20261026T090100Z-ab12:shred-drill-20261026']);
    expect(r.facts).toEqual({ tenant: 'shred-drill-20261026', tenantId: 't-id', keyVersion: 1, values: 3, op: 'op-1' });
  });

  it.each<[string, Partial<DrillDeps>, number]>([
    ['a tenant from today exists', { createTenant: () => ({ ok: false, lines: ['shred-drill-20261026 exists: each drill gets a fresh tenant'] }) }, 1],
    ['the backup fails', { backup: () => Promise.resolve({ ok: false, lines: ['no destination'] }) }, 2],
    ['the destruction is refused', { destroy: () => Promise.resolve({ ok: false, lines: ['not eligible'] }) }, 3],
  ])('stops at the first failure: %s', async (_n, over, step) => {
    const { deps, calls } = scripted(over);
    const r = await drill(NOW, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toMatch(new RegExp(`^STOP at ${String(step)}/4`));
    expect(calls).toHaveLength(step - 1);
  });

  it('a failed rehearsal fails the drill, and keeps its facts for the record', async () => {
    const { deps } = scripted({ rehearse: () => Promise.resolve({ ok: false, lines: ['FAIL decryption after recovery'], record: null }) });
    const r = await drill(NOW, deps);
    expect(r.ok).toBe(false);
    expect(r.lines.at(-1)).toBe('STOP at 4/4 (the rehearsal): the drill failed');
    expect(r.facts?.op).toBe('op-1');
  });
});
