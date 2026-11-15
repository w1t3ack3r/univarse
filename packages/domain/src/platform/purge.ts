// Spec 0038 Q9–Q13 (A7, A12, T36): an archived institution's purge, as rules. Pure: the console asks and approves, the
// host runs the steps; which institution may be purged, whether an authorisation still stands, whether one person may
// do it alone, and which step comes next are decided here and tested on their own.
import { PLATFORM_ROLE_PERMISSIONS, isPlatformRole } from './permissions.js';

const DAY_MS = 86_400_000;

/** Q9: an authorisation is used within 7 days of its approval, or not at all. */
export const PURGE_AUTHORISATION_DAYS = 7;

/** Q10: the drill tenants are evidence (spec 0020 D11); nothing purges them. */
export const DRILL_SLUG_PREFIX = 'shred-drill-';
export const isDrillSlug = (slug: string): boolean => slug.startsWith(DRILL_SLUG_PREFIX);

/** Q9: only an archived institution, never a drill tenant. */
export const purgeable = (t: { readonly status: string; readonly slug: string }): boolean => t.status === 'ARCHIVED' && !isDrillSlug(t.slug);

/** Q9, Q-C1: when an authorisation (an executed `tenant.purge` approval) stops being usable. */
export const purgeAuthorisationExpiry = (executedAt: Date): Date => new Date(executedAt.getTime() + PURGE_AUTHORISATION_DAYS * DAY_MS);

/** Whether an executed approval still authorises a purge now: within its 7 days and not yet used by a purge. */
export const authorisationUsable = (a: { readonly executedAt: Date; readonly usedBy: string | null }, now: Date): boolean =>
  a.usedBy === null && now.getTime() < purgeAuthorisationExpiry(a.executedAt).getTime();

/**
 * Q11, Q-C4 (A7): a purge may run solo only when no second person could approve one: at most one active member, with an
 * authenticator, holds the approve permission. The check is live, at the moment the host asks.
 */
export function soloPurgeAllowed(staff: readonly { readonly role: string; readonly isActive: boolean; readonly mfaEnrolled: boolean }[]): boolean {
  const deciders = staff.filter((s) => s.isActive && s.mfaEnrolled && isPlatformRole(s.role) && PLATFORM_ROLE_PERMISSIONS[s.role].includes('platform.approval.decide'));
  return deciders.length <= 1;
}

/** Q10's steps, in their only order (A12: the keys first, so nothing deleted later can be read from a backup). */
export const PURGE_STEPS = ['keys', 'rows', 'objects', 'platform', 'certificate'] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

/** What each step records when it's done. */
export interface PurgeProgress {
  readonly keysDestroyedAt: Date | null;
  readonly rowsDeletedAt: Date | null;
  readonly objectsDeletedAt: Date | null;
  readonly platformDeletedAt: Date | null;
  readonly certificateAt: Date | null;
}

const DONE: Readonly<Record<PurgeStep, keyof PurgeProgress>> = {
  keys: 'keysDestroyedAt',
  rows: 'rowsDeletedAt',
  objects: 'objectsDeletedAt',
  platform: 'platformDeletedAt',
  certificate: 'certificateAt',
};

/** Q-C3: the first step not yet recorded, or null when the purge is complete. A later step is never next before an earlier one. */
export function nextPurgeStep(p: PurgeProgress): PurgeStep | null {
  for (const step of PURGE_STEPS) if (p[DONE[step]] === null) return step;
  return null;
}

/** Whether `step` may run now: it is the next one (a step already done is skipped; a later one waits). */
export const purgeStepMayRun = (p: PurgeProgress, step: PurgeStep): boolean => nextPurgeStep(p) === step;

/** Q11: a solo purge's reason, as the host command takes it. */
export const PURGE_REASON_MIN = 10;
export const PURGE_REASON_MAX = 500;
export const purgeReasonProblem = (reason: string | undefined): boolean => {
  const r = reason?.trim() ?? '';
  return r.length < PURGE_REASON_MIN || r.length > PURGE_REASON_MAX;
};
