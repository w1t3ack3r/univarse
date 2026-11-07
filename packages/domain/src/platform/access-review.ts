/**
 * Spec 0031 Q15: the monthly access review's rules. Pure, so the month's boundary and the snapshot's identity are
 * tested exactly. One review a calendar month in WAT (UTC+1, no daylight saving).
 */
const WAT_OFFSET_MS = 60 * 60_000;

/** The review month a moment falls in, in WAT: `2026-11`. */
export function reviewPeriod(at: Date): string {
  return new Date(at.getTime() + WAT_OFFSET_MS).toISOString().slice(0, 7);
}

/** The month before a period: `2026-01` → `2025-12`. */
export function previousReviewPeriod(period: string): string {
  const [year = 0, month = 1] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

export type ReviewStatus = 'done' | 'due' | 'overdue';

/**
 * Where this month's review stands, given the newest review's period (null if none). `done` once this month's exists.
 * `overdue` when last month has none either, but only once there is a review to be late from: a platform that has never
 * reviewed is simply `due`, so the first month after S3 ships doesn't open overdue.
 */
export function reviewStatus(at: Date, newestPeriod: string | null): ReviewStatus {
  const current = reviewPeriod(at);
  if (newestPeriod === current) return 'done';
  if (newestPeriod === null) return 'due';
  return newestPeriod < previousReviewPeriod(current) ? 'overdue' : 'due';
}

/** What a review attests about one member. Only these decide the snapshot's identity. */
export interface ReviewedAccess {
  readonly id: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly mfaEnrolled: boolean;
}

/**
 * The canonical text the snapshot's hash covers: access itself, sorted by id, nothing else. A last sign-in or a session
 * count is shown but left out: they change whenever anyone signs in, the reviewer included, and a hash over them could
 * never match between loading the page and attesting.
 */
export function canonicalReviewedAccess(members: readonly ReviewedAccess[]): string {
  const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(sorted.map((m) => [m.id, m.role, m.isActive, m.mfaEnrolled]));
}

export type ReviewDecision = 'keep' | 'change';

/** Which member ids a review's decisions leave out or add: both must be empty for it to be accepted. */
export function reviewDecisionGaps(memberIds: readonly string[], decided: readonly string[]): { readonly missing: string[]; readonly unknown: string[] } {
  const members = new Set(memberIds);
  const seen = new Set(decided);
  return { missing: memberIds.filter((id) => !seen.has(id)), unknown: decided.filter((id) => !members.has(id)) };
}
