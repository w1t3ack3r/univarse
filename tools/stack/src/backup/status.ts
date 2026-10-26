// Spec 0020 D6, BK8, B2-2: `pnpm stack:backup status`, from what needs no private key: the clear indexes, the WAL
// area's file names, the staging volume's listing, the scheduled tasks and the ledger. The report is a pure function
// of those inputs, so every boundary is tested; status-deps.ts reads them. Nothing in it is secret.
import { checkoutProblem, type CheckoutRecord } from './checkout.js';
import type { SetOnDisk } from './set.js';
import { tokenReport, type TokenState } from '../vault.js';

export const NEWEST_SET_WARN_H = 26;
export const STAGED_WARN_H = 1;
const HOUR = 3600 * 1000;

/** A file and when it was written: a shipped WAL file at the destination, or a staged one in the volume. */
export interface Dated {
  readonly name: string;
  readonly at: Date;
}

/** One scheduled task: registered or not, and its last run. */
export interface TaskState {
  readonly name: string;
  readonly registered: boolean;
  readonly lastRun?: Date | null;
  readonly lastResult?: number | null;
}

export interface StatusInputs {
  readonly now: Date;
  readonly destination: string;
  /** The destination's sets, or why they couldn't be read. */
  readonly sets: readonly SetOnDisk[] | { readonly problem: string };
  readonly shipped: readonly Dated[] | { readonly problem: string };
  /** The staging volume's files, or why they couldn't be read (Docker not running, say). */
  readonly staged: readonly Dated[] | { readonly problem: string };
  /** The scheduled tasks; null where there is no Task Scheduler (not Windows). */
  readonly schedule: readonly TaskState[] | null | { readonly problem: string };
  /** D7's external-drive rule: null when it holds. */
  readonly externalRule: string | null;
  /** BK17: the waiver statement of the ledger's generation, or null; or why the ledger couldn't be read. */
  readonly waived: string | null | { readonly problem: string };
  /** Spec 0023 T5: the two Vault tokens' remaining life, or why it couldn't be read; absent where not asked. */
  readonly tokens?: readonly TokenState[] | { readonly problem: string };
  /** B2-4: what the last scheduled run's checkout was; null before the first; absent where not asked. */
  readonly checkout?: CheckoutRecord | null | { readonly problem: string };
}

export interface StatusReport {
  /** False only when something couldn't be read (B2-2's exit code). */
  readonly ok: boolean;
  readonly lines: string[];
  /** The WARN lines alone: what the deploy prints (B2-3). */
  readonly warnings: string[];
}

/** An age a person reads at a glance: minutes under 2 h, hours under 2 days, then days and hours. */
export function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 120) return `${String(m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)} h ${String(m % 60)} min`;
  return `${String(Math.floor(h / 24))} d ${String(h % 24)} h`;
}

const failed = (v: unknown): v is { readonly problem: string } => typeof v === 'object' && v !== null && 'problem' in v;

export function statusReport(i: StatusInputs): StatusReport {
  const lines: string[] = [];
  const warnings: string[] = [];
  let ok = true;
  const warn = (l: string) => {
    warnings.push(l);
    lines.push(`WARN ${l}`);
  };
  const since = (d: Date) => i.now.getTime() - d.getTime();

  lines.push(`destination: ${i.destination}`);
  if (failed(i.sets)) {
    ok = false;
    warn(`the backup sets can't be read: ${i.sets.problem}`);
  } else {
    const complete = i.sets.filter((s) => s.index).sort((a, b) => a.setId.localeCompare(b.setId));
    const newest = complete.at(-1);
    const oldest = complete[0];
    if (!newest || !oldest) warn('no complete backup set: run `pnpm stack:backup`');
    else {
      lines.push(`newest set: ${newest.setId}, ${age(since(newest.createdAt))} old`);
      if (since(newest.createdAt) > NEWEST_SET_WARN_H * HOUR) warn(`the newest set is older than ${String(NEWEST_SET_WARN_H)} hours: is the daily backup running? (\`pnpm stack:backup status\`, the schedule's last result)`);
      // D6: the actual erasure boundary is the oldest set still kept, whatever the schedule promised.
      lines.push(`erasure boundary: ${age(since(oldest.createdAt))} (the oldest of ${String(complete.length)} retained set${complete.length === 1 ? '' : 's'}, ${oldest.setId})`);
    }
    const incomplete = i.sets.filter((s) => !s.index).map((s) => s.setId);
    if (incomplete.length) lines.push(`incomplete sets (ignored; a prune removes them after a day): ${incomplete.join(', ')}`);
  }

  if (failed(i.shipped)) {
    ok = false;
    warn(`the shipped WAL can't be read: ${i.shipped.problem}`);
  } else {
    const newest = [...i.shipped].sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1);
    lines.push(newest ? `WAL shipped: newest ${newest.name}, ${age(since(newest.at))} ago` : 'WAL shipped: none yet');
  }

  if (failed(i.staged)) {
    ok = false;
    warn(`the staged WAL can't be read: ${i.staged.problem}`);
  } else if (!i.staged.length) lines.push('WAL staged: none waiting');
  else {
    const oldest = [...i.staged].sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    if (oldest) {
      lines.push(`WAL staged: ${String(i.staged.length)} waiting, the oldest ${age(since(oldest.at))}`);
      // B-2's stated limit: staged WAL is inside the stack's failure domain until shipped.
      if (since(oldest.at) > STAGED_WARN_H * HOUR) warn(`WAL has waited over ${String(STAGED_WARN_H)} hour to ship: run \`pnpm stack:backup wal\`, or check the WAL task`);
    }
  }

  if (i.schedule === null) lines.push('schedule: not on Windows (`pnpm stack:backup schedule` prints the crontab lines)');
  else if (failed(i.schedule)) {
    ok = false;
    warn(`the scheduled tasks can't be read: ${i.schedule.problem}`);
  } else {
    for (const t of i.schedule) {
      if (!t.registered) {
        warn(`scheduled task ${t.name} is not registered: \`pnpm stack:backup schedule --at <HH:MM> --apply\``);
        continue;
      }
      const last = t.lastRun ? `last run ${age(since(t.lastRun))} ago, result ${String(t.lastResult ?? 'unknown')}` : 'not run yet';
      lines.push(`scheduled task ${t.name}: ${last}`);
      if (t.lastResult !== 0 && t.lastResult !== null && t.lastResult !== undefined) warn(`scheduled task ${t.name}'s last run failed (result ${String(t.lastResult)}): see ~/.univarse/stack/logs/`);
    }
  }

  if (i.externalRule) warn(i.externalRule);

  if (failed(i.waived)) {
    ok = false;
    warn(`the shred ledger can't be read: ${i.waived.problem}`);
  } else if (i.waived) lines.push(i.waived);

  // Spec 0023 T5: a token near its end stops the backup (its Vault snapshot) and the app; the deploy shows this too.
  if (i.tokens !== undefined) {
    if (failed(i.tokens)) {
      ok = false;
      warn(`the Vault tokens can't be read: ${i.tokens.problem}`);
    } else {
      const t = tokenReport(i.tokens);
      lines.push(...t.lines);
      for (const pr of t.problems) warn(pr);
    }
  }

  // B2-4: shown until a later scheduled run finds a clean main; it names the branch, never a file.
  if (i.checkout !== undefined && i.checkout !== null) {
    if (failed(i.checkout)) {
      ok = false;
      warn(`the last scheduled run's checkout can't be read: ${i.checkout.problem}`);
    } else {
      const problem = checkoutProblem(i.checkout);
      if (problem) warn(`${problem} (${age(since(new Date(i.checkout.at)))} ago)`);
    }
  }

  return { ok, lines, warnings };
}
