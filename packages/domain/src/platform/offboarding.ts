/**
 * Spec 0038 Q2–Q6: an institution's departure, before the purge. Pure, so the rules are tested without a database.
 * Starting it opens a 60-day window that ends on a day, in Nigerian time; warnings go out at fixed days left, each
 * once; on the last day the institution is archived; an archive can be given 14 more days, once.
 */
import type { TenantStatusName } from './tenant-registry.js';

export const OFFBOARDING_REASONS = ['CONTRACT_ENDED', 'INSTITUTION_ASKED', 'REGULATOR_ORDER', 'OTHER'] as const;
export type OffboardingReason = (typeof OFFBOARDING_REASONS)[number];
export const isOffboardingReason = (v: string): v is OffboardingReason => (OFFBOARDING_REASONS as readonly string[]).includes(v);

export const OFFBOARDING_DAYS = 60;
export const EXTENSION_DAYS = 14;
/** Q4: the first round's warnings, by days left; 60 is the announcement itself. */
export const WARNING_DAYS = [60, 45, 30, 14, 7, 1] as const;
/** Q6: the extension's; 14 is its announcement. */
export const EXTENSION_WARNING_DAYS = [14, 7, 1] as const;
export const OFFBOARDING_NOTE_MAX = 200;

const DAY_MS = 86_400_000;
/** Nigeria keeps UTC+1 all year. */
const LAGOS_OFFSET_MS = 3_600_000;

/** Q2: from active or onboarding. A suspended institution is resumed first. */
export const offboardable = (status: TenantStatusName): boolean => status === 'ACTIVE' || status === 'ONBOARDING';

/**
 * Q2: when a window of `days` started at `start` ends: the end of its last day in Nigerian time (23:59:59.999 WAT,
 * `days` calendar days after the day it started).
 */
export function windowEnd(start: Date, days: number): Date {
  const local = new Date(start.getTime() + LAGOS_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnight + (days + 1) * DAY_MS - 1 - LAGOS_OFFSET_MS);
}

/** Whole days left until `end`, counted as the institution would: 1 on the last day, 0 once it's over. */
export function daysLeft(end: Date, now: Date): number {
  if (now.getTime() > end.getTime()) return 0;
  return Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
}

/**
 * Q4: the warning to send now, or null. The most recent one due that hasn't been sent: a worker that was down sends
 * the latest, never a backlog. `round` 0 is the first window, 1 the extension.
 */
export function dueWarning(round: 0 | 1, end: Date, sent: readonly number[], now: Date): number | null {
  const days = round === 0 ? WARNING_DAYS : EXTENSION_WARNING_DAYS;
  // The day it starts counts one more than the round's first warning (the rest of today, then 60 days): the
  // announcement is due from the start.
  const left = Math.min(daysLeft(end, now), days[0]);
  if (left === 0) return null;
  const due = days.filter((d) => d >= left);
  const latest = due.length ? Math.min(...due) : null;
  if (latest === null || sent.some((s) => s <= latest)) return null;
  return latest;
}

/** Q5: whether the worker archives it now. */
export const archiveDue = (status: TenantStatusName, end: Date, now: Date): boolean => status === 'OFFBOARDING' && now.getTime() > end.getTime();

/** Q2: a window can be cancelled while it's open, never after the archive. */
export const cancellable = (status: TenantStatusName, end: Date, now: Date): boolean => status === 'OFFBOARDING' && now.getTime() <= end.getTime();

/** Q6: an archived institution gets 14 more days, once. */
export const extendable = (status: TenantStatusName, extensionsUsed: number): boolean => status === 'ARCHIVED' && extensionsUsed === 0;

export type OffboardingNoteProblem = 'note_required' | 'note_length';

/** As a suspension's note: required for "other", 3 to 200 characters. */
export function offboardingNoteProblem(reason: OffboardingReason, note: string | null | undefined): OffboardingNoteProblem | null {
  const n = note?.trim() ?? '';
  if (n === '') return reason === 'OTHER' ? 'note_required' : null;
  return n.length < 3 || n.length > OFFBOARDING_NOTE_MAX ? 'note_length' : null;
}

export type TestClockProblem = 'not_offboarding' | 'went_live' | 'already_archived';

/**
 * Spec 0038 Q-D3: whether the stack's test clock may archive an institution now, as if its window had ended. Only an
 * institution that is leaving and never went live: its open offboarding started from ONBOARDING. `previousStatus` is
 * that offboarding's, or null when none is open. An archived one is `already_archived` (the caller finishes its
 * session ending and reports success); one that went live is refused whatever its status now.
 */
export function testClockArchiveProblem(i: { status: TenantStatusName; previousStatus: TenantStatusName | null }): TestClockProblem | null {
  if (i.previousStatus === null) return 'not_offboarding';
  if (i.previousStatus !== 'ONBOARDING') return 'went_live';
  if (i.status === 'ARCHIVED') return 'already_archived';
  return i.status === 'OFFBOARDING' ? null : 'not_offboarding';
}
