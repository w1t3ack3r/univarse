// Spec 0020 B-14: one tenant's verdict from its decrypt samples.
import { describe, expect, it } from 'vitest';
import { decryptStatus, DRILL_SLUG } from './backup-checks.js';

describe('decryptStatus', () => {
  it('ok only when every sample decrypts; key_destroyed only when every failure is a destroyed key', () => {
    expect(decryptStatus([])).toBe('empty');
    expect(decryptStatus(['ok', 'ok'])).toBe('ok');
    expect(decryptStatus(['key_destroyed', 'key_destroyed'])).toBe('key_destroyed');
    expect(decryptStatus(['ok', 'key_destroyed'])).toBe('failed');
    expect(decryptStatus(['ok', 'failed'])).toBe('failed');
    expect(decryptStatus(['key_destroyed', 'failed'])).toBe('failed');
  });
});

describe('DRILL_SLUG', () => {
  it('names a drill tenant by its date, and nothing else', () => {
    expect(DRILL_SLUG.test('shred-drill-20261024')).toBe(true);
    for (const s of ['shred-drill', 'shred-drill-2026', 'demo-uni', 'shred-drill-20261024-x', 'x-shred-drill-20261024']) expect([s, DRILL_SLUG.test(s)]).toEqual([s, false]);
  });
});
