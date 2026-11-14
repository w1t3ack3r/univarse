/**
 * Spec 0037 Q6, Q7: suspending an institution and resuming it. Pure, so the rules are tested without a database.
 * One person decides, with a step-up and a reason from a fixed list. Non-payment isn't on the list: spec 0030 says
 * unpaid bills hold new admissions and registrations, never sign-in.
 */
import type { TenantStatusName } from './tenant-registry.js';

export const SUSPENSION_REASONS = ['SECURITY_INCIDENT', 'REGULATOR_ORDER', 'CONTRACT_ENDED', 'INSTITUTION_ASKED', 'OTHER'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];
export const isSuspensionReason = (v: string): v is SuspensionReason => (SUSPENSION_REASONS as readonly string[]).includes(v);

/** Q6: the note is staff-only and short. "Other" needs one; the rest may carry one. */
export const SUSPENSION_NOTE_MIN = 3;
export const SUSPENSION_NOTE_MAX = 200;

/** The statuses a suspension can start from, and so the ones a resume can return to. */
const SUSPENDABLE: ReadonlySet<TenantStatusName> = new Set(['ACTIVE', 'ONBOARDING']);
export const suspendable = (status: TenantStatusName): boolean => SUSPENDABLE.has(status);
export const resumableTo = (status: string): status is 'ACTIVE' | 'ONBOARDING' => SUSPENDABLE.has(status as TenantStatusName);

export type SuspensionNoteProblem = 'note_required' | 'note_length';

/** Q6: the note's rules, or null when it's fine. Whitespace alone is no note. */
export function suspensionNoteProblem(reason: SuspensionReason, note: string | null | undefined): SuspensionNoteProblem | null {
  const n = note?.trim() ?? '';
  if (n === '') return reason === 'OTHER' ? 'note_required' : null;
  if (n.length < SUSPENSION_NOTE_MIN || n.length > SUSPENSION_NOTE_MAX) return 'note_length';
  return null;
}

export type ResumeRefusal = 'not_suspended' | 'sessions_ending';

/**
 * Q7: a resume waits until the worker has ended every session the suspension found. Otherwise a session stolen before
 * a security incident's suspension would work again the moment the institution came back.
 */
export function resumeRefusal(t: { status: TenantStatusName }, open: { sessionsEndedAt: Date | null } | null): ResumeRefusal | null {
  if (t.status !== 'SUSPENDED') return 'not_suspended';
  if (open && open.sessionsEndedAt === null) return 'sessions_ending';
  return null;
}
