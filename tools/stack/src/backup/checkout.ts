// Spec 0020 B2-4 (added 2026-10-25, approved by the owner; built in B2b): the scheduled tasks run whatever this checkout
// holds, so a scheduled run notes what that was. A checkout that isn't a clean `main` still backs up (an imperfect
// backup beats none), but the run logs a WARN, and `stack:backup status` (and so the deploy) keeps warning until a
// later scheduled run finds it clean. Only the branch's name and whether tracked files have changes are recorded:
// never a file's name or contents. Untracked files don't count (an uncommitted drill record, say).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../../../packages/db/scripts/pgbouncer-config.js';
import { REPO, STACK_DIR } from '../config.js';

export interface Checkout {
  readonly branch: string;
  readonly dirty: boolean;
}
export interface CheckoutRecord extends Checkout {
  readonly at: string;
}

type Git = (args: readonly string[]) => { status: number | null; stdout: string };
const git: Git = (args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });

/** The checkout's branch (or `HEAD` when detached) and whether any tracked file differs from it. */
export function checkoutState(run: Git = git): Checkout {
  const b = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const s = run(['status', '--porcelain', '--untracked-files=no']);
  if (b.status !== 0 || s.status !== 0) throw new Error("this checkout's state can't be read (git)");
  return { branch: b.stdout.trim(), dirty: s.stdout.trim() !== '' };
}

/** Why a checkout isn't what the scheduled tasks should run, or null. */
export function checkoutProblem(c: Checkout): string | null {
  if (c.branch === 'main' && !c.dirty) return null;
  const what = c.branch === 'HEAD' ? 'a detached HEAD' : `branch ${c.branch}`;
  return `the scheduled backup ran from ${what}${c.dirty ? ', with uncommitted changes' : ''}: this checkout should stay on a clean main, with branch work in worktrees`;
}

const file = (dir: string) => join(dir, 'backup-checkout.json');

export function recordCheckout(c: Checkout, at: Date, dir = STACK_DIR): void {
  writeOwnerOnly(file(dir), `${JSON.stringify({ ...c, at: at.toISOString() } satisfies CheckoutRecord, null, 2)}\n`);
}

/** The last scheduled run's record, or null before the first. */
export function lastCheckout(dir = STACK_DIR): CheckoutRecord | null {
  if (!existsSync(file(dir))) return null;
  return JSON.parse(readFileSync(file(dir), 'utf8')) as CheckoutRecord;
}
