// Spec 0037 (E4): how the console says what a two-person request is, where it stands, and why one failed. Pure, so the
// words are tested; every kind the engine knows has its sentence here (a test).
import type { PlatformApproval } from '@univarse/contracts';

type Kind = PlatformApproval['kind'];
type Status = PlatformApproval['status'];

/** The action, said as an instruction, with the person it names. */
export function approvalAction(a: Pick<PlatformApproval, 'kind' | 'subject'>): string {
  const who = a.subject?.name ?? 'a former member';
  const sentences: Record<Kind, string> = {
    'staff.make_owner': `Make ${who} an owner`,
  };
  return sentences[a.kind];
}

/** What approving does, said before anyone presses it. */
export const APPROVAL_CONSEQUENCE: Readonly<Record<Kind, string>> = {
  'staff.make_owner': 'They get every permission in the console, including who can reach it. They’re emailed when it’s done.',
};

/** The short kind name, for lists and the inbox. */
export const APPROVAL_KIND_LABEL: Readonly<Record<Kind, string>> = {
  'staff.make_owner': 'Make an owner',
};

export const APPROVAL_STATUS: Readonly<Record<Status, { readonly text: string; readonly tone: string }>> = {
  PENDING: { text: 'Waiting for a second person', tone: 'pc-status--wait' },
  APPROVED: { text: 'Approved, running', tone: 'pc-status--wait' },
  EXECUTED: { text: 'Approved and done', tone: 'pc-status--on' },
  FAILED: { text: 'Approved, not done', tone: 'pc-status--off' },
  REJECTED: { text: 'Rejected', tone: 'pc-status--off' },
  CANCELLED: { text: 'Cancelled', tone: 'pc-status--none' },
  EXPIRED: { text: 'Expired', tone: 'pc-status--none' },
};

/** Why an approved request couldn't run: things changed between the asking and the approval. */
export const APPROVAL_FAILURE: Readonly<Record<NonNullable<PlatformApproval['failureCode']>, string>> = {
  subject_gone: 'The member it named is no longer on the platform.',
  subject_inactive: 'The member it named had lost access by then.',
  already_done: 'It had already happened another way.',
  state_conflict: 'The person who asked could no longer ask for this by then.',
};

/** "in 5 h", "in 40 min" or "in under a minute", for an expiry still ahead. Hours round down: never later than it is. */
export function timeLeft(iso: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms < 60_000) return 'in under a minute';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `in ${String(min)} min`;
  return `in ${String(Math.floor(min / 60))} h`;
}
