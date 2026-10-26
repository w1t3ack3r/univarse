// Spec 0020 B2-11, BK9: the drill's record, and the scan it passes before it is written.
import { describe, expect, it } from 'vitest';
import type { RestoreRecord } from './engine.js';
import { cell, recordMarkdown, secretProblems } from './record.js';

const RECORD: RestoreRecord = {
  mode: 'rehearsal',
  setId: '20261026T020000Z-ab12',
  release: 'releases/2026-10-25-e6a0066.json',
  target: "the set's position 0/5000060",
  checks: [
    { name: 'files', ok: true, detail: '2 objects written through the filer' },
    { name: 'row counts', ok: true, detail: 'equal | to the set\'s' },
  ],
  rtoSeconds: 412,
  rpoSeconds: 95,
  peakMemoryMb: 1320,
  decryptBefore: { 'shred-drill-20261026': { status: 'ok', sampled: 3 }, 'demo-uni': { status: 'ok', sampled: 5 } },
  decryptAfter: { 'shred-drill-20261026': { status: 'key_destroyed', sampled: 3 }, 'demo-uni': { status: 'ok', sampled: 5 } },
};
const DRILL = { tenant: 'shred-drill-20261026', tenantId: '9f0c2f1e-0000-4000-8000-000000000001', keyVersion: 1, values: 3, op: '5b1c0d2e-0000-4000-8000-000000000002' };

describe('[B2-11] the record', () => {
  it('the drill\'s: the set, the release, the timings, the drill tenant before and after, every check', () => {
    const md = recordMarkdown(RECORD, { date: '2026-10-26', tools: 'abc1234', drill: DRILL });
    expect(md).toMatch(/^# Restore and shred drill, 2026-10-26$/m);
    expect(md).toContain('| RTO | 6.9 min, from the first unseal to the last check |');
    expect(md).toContain('| RPO reached | 95 s:');
    expect(md).toContain('| Peak memory | 1320 MiB');
    expect(md).toContain('- **Before recovery (the control):** ok (3 sampled).');
    expect(md).toContain('- **After recovery:** key_destroyed (3 sampled).');
    expect(md).toContain('| row counts | PASS | equal \\| to the set\'s |');
    expect(md).toContain('| `demo-uni` | ok (5 sampled) | ok (5 sampled) |');
  });

  it('a rehearsal\'s has no drill section', () => {
    const md = recordMarkdown(RECORD, { date: '2026-10-26', tools: 'abc1234' });
    expect(md).toMatch(/^# Restore rehearsal, 2026-10-26$/m);
    expect(md).not.toContain('## The drill');
  });

  it('passes BK9\'s scan', () => {
    expect(secretProblems(recordMarkdown(RECORD, { date: '2026-10-26', tools: 'abc1234', drill: DRILL }), ['a-stack-secret-value-1234'])).toEqual([]);
  });
});

describe('[BK9] the scan', () => {
  it('finds a secret value, a Vault token, a PEM block and a key file\'s ciphertext, without naming any', () => {
    const secret = 'Zx9-pl4nted-not-a-real-secret';
    expect(secretProblems(`a line with ${secret} in it`, [secret])).toEqual(["1 of the stack's secret values"]);
    expect(secretProblems('token hvs.CAESIJ1234567890abcdef', [])).toEqual(['a Vault token']);
    expect(secretProblems('-----BEGIN PRIVATE KEY-----\nMC4C', [])).toEqual(['a PEM block']);
    expect(secretProblems('{"iv":"x","ciphertext":"y"}', [])).toEqual(["a key file's ciphertext"]);
  });

  it('ignores hashes, ids and short values', () => {
    expect(secretProblems(`sha ${'a'.repeat(64)} id 9f0c2f1e-0000-4000-8000-000000000001`, ['short'])).toEqual([]);
  });
});

describe('[B2-11] a table cell', () => {
  it('escapes backslashes before pipes, so a detail ending in a backslash can\'t end its cell', () => {
    // In source: one backslash is written '\\'.
    expect(cell('a | b')).toBe('a \\| b');
    expect(cell('x\\')).toBe('x\\\\');
    expect(cell('x\\|y')).toBe('x\\\\\\|y');
  });
});
