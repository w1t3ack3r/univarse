// Spec 0020 D7, B-9: backups on an external drive need a ledger destination on that drive.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devOf, externalRuleProblem, type DevOf } from './external.js';

/** Paths under /c are disk 1, under /e disk 2, under /f disk 3; anything else can't be read. */
const fake: DevOf = (p) => ({ c: 1n, e: 2n, f: 3n })[p.split('/')[1] ?? ''] ?? null;

describe('externalRuleProblem', () => {
  it('holds when the backups share the primary\'s disk', () => {
    expect(externalRuleProblem('/c/backups', '/c/ledger', ['/c/ledger'], fake)).toBeNull();
  });

  it('on another drive, needs a ledger destination on that same drive', () => {
    expect(externalRuleProblem('/e/backups', '/c/ledger', ['/c/ledger'], fake)).toMatch(/must hold a ledger destination too.*add-destination/);
    expect(externalRuleProblem('/e/backups', '/c/ledger', ['/c/ledger', '/f/ledger'], fake)).toMatch(/must hold a ledger destination/);
    expect(externalRuleProblem('/e/backups', '/c/ledger', ['/c/ledger', '/e/univarse-ledger'], fake)).toBeNull();
  });

  it('an unreadable backup destination or primary is a problem, never a pass', () => {
    expect(externalRuleProblem('/x/backups', '/c/ledger', ['/c/ledger'], fake)).toMatch(/can't be read: is the drive connected/);
    expect(externalRuleProblem('/e/backups', '/x/ledger', ['/x/ledger'], fake)).toMatch(/primary .* can't be read/);
  });

  it('devOf reads a path that does not exist yet from its nearest existing parent', () => {
    const d = mkdtempSync(join(tmpdir(), 'uv-dev-'));
    expect(devOf(join(d, 'not', 'yet'))).toBe(devOf(d));
  });
});
