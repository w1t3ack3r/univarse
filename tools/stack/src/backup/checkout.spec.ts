// Spec 0020 B2-4 (built in B2b): a scheduled run notes its checkout; anything but a clean main is warned about, by the
// branch's name only, and `status` keeps warning until a later scheduled run is clean.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutProblem, checkoutState, lastCheckout, recordCheckout } from './checkout.js';
import { statusReport, type StatusInputs } from './status.js';

const git = (branch: string, porcelain: string) => (args: readonly string[]) => ({ status: 0, stdout: args[0] === 'rev-parse' ? `${branch}\n` : porcelain });

describe('[B2-4] the checkout a scheduled run ran from', () => {
  it('reads the branch, and whether a tracked file changed (untracked ones are never asked for)', () => {
    const seen: string[][] = [];
    const run = (args: readonly string[]) => (seen.push([...args]), git('main', '')(args));
    expect(checkoutState(run)).toEqual({ branch: 'main', dirty: false });
    expect(seen).toContainEqual(['status', '--porcelain', '--untracked-files=no']);
    expect(checkoutState(git('main', ' M tools/stack/src/x.ts\n'))).toEqual({ branch: 'main', dirty: true });
  });

  it('a clean main is no problem; a branch, changes or a detached HEAD each are, named without a file', () => {
    expect(checkoutProblem({ branch: 'main', dirty: false })).toBeNull();
    expect(checkoutProblem({ branch: 'feat/restore-drill', dirty: false })).toMatch(/^the scheduled backup ran from branch feat\/restore-drill: /);
    expect(checkoutProblem({ branch: 'main', dirty: true })).toMatch(/ran from branch main, with uncommitted changes/);
    expect(checkoutProblem({ branch: 'HEAD', dirty: false })).toMatch(/ran from a detached HEAD/);
  });

  it('a git that can\'t be read is said so, not taken for clean', () => {
    expect(() => checkoutState(() => ({ status: 128, stdout: '' }))).toThrow(/can't be read/);
  });
});

describe('[B2-4] status keeps warning until a clean run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uv-checkout-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const NOW = new Date('2026-10-26T10:00:00Z');
  const inputs = (checkout: NonNullable<StatusInputs['checkout']> | null): StatusInputs => ({ now: NOW, destination: '/b', sets: [], shipped: [], staged: [], schedule: null, externalRule: null, waived: null, checkout });

  it('the last run\'s record: a branch warns, with its age; a later clean run clears it', () => {
    recordCheckout({ branch: 'feat/x', dirty: true }, new Date('2026-10-26T09:15:00Z'), dir);
    const warned = statusReport(inputs(lastCheckout(dir)));
    expect(warned.warnings).toContain('the scheduled backup ran from branch feat/x, with uncommitted changes: this checkout should stay on a clean main, with branch work in worktrees (45 min ago)');
    recordCheckout({ branch: 'main', dirty: false }, new Date('2026-10-26T09:30:00Z'), dir);
    expect(statusReport(inputs(lastCheckout(dir))).warnings.join()).not.toMatch(/scheduled backup ran from/);
  });

  it('before the first scheduled run there is nothing to say; a record that can\'t be read makes status fail', () => {
    expect(lastCheckout(dir)).toBeNull();
    expect(statusReport(inputs(null)).warnings.join()).not.toMatch(/checkout/);
    const r = statusReport(inputs({ problem: 'not JSON' }));
    expect(r.ok).toBe(false);
    expect(r.warnings).toContain("the last scheduled run's checkout can't be read: not JSON");
  });
});
