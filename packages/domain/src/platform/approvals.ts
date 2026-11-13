/**
 * Spec 0037 Q2–Q5 (E4, T24): the two-person approval engine's rules. Pure: the API stores, hashes and executes; every
 * decision about who may do what, and whether an approval still stands, is made here and tested on its own.
 */
import { PLATFORM_ROLE_PERMISSIONS, isPlatformRole, type PlatformPermission } from './permissions.js';

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'EXECUTED', 'FAILED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

const HOUR_MS = 3_600_000;

/** A kind of two-person action. Each later one (S7's purge, S10's prices) is a new entry here, never a new engine. */
export interface ApprovalKindSpec {
  /** What the requester must hold, checked with the catalogue's step-up rule. */
  readonly requestPermission: PlatformPermission;
  /** What the approver must hold, as well. */
  readonly approvePermission: PlatformPermission;
  /** How long a request waits for a decision. */
  readonly ttlMs: number;
  /** The payload's one field naming a person, if any: they can't approve it (Q3). */
  readonly subjectField: string | null;
}

export const APPROVAL_KINDS: Readonly<Record<'staff.make_owner', ApprovalKindSpec>> = Object.freeze({
  /** Q4: raising a member to OWNER. */
  'staff.make_owner': { requestPermission: 'platform.staff.manage', approvePermission: 'platform.approval.decide', ttlMs: 24 * HOUR_MS, subjectField: 'memberId' },
});

export type ApprovalKind = keyof typeof APPROVAL_KINDS;
export const APPROVAL_KIND_NAMES = Object.keys(APPROVAL_KINDS) as ApprovalKind[];
export const isApprovalKind = (k: string): k is ApprovalKind => Object.hasOwn(APPROVAL_KINDS, k);

/** Failure codes an execution may store: fixed, so no driver message reaches the console (as spec 0034 Q4). */
export const APPROVAL_FAILURES = ['subject_gone', 'subject_inactive', 'already_done', 'state_conflict'] as const;
export type ApprovalFailure = (typeof APPROVAL_FAILURES)[number];

/**
 * The one text form of a payload that is hashed (Q3): keys sorted at every depth, no whitespace. Two payloads with the
 * same content always give the same text, whatever order their keys were written in. Non-JSON values are refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not JSON: a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const proto: unknown = typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (typeof value === 'object' && (proto === Object.prototype || proto === null)) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`not JSON: ${typeof value}`);
}

/** The person a payload names, if its kind has one. */
export function approvalSubject(kind: ApprovalKind, payload: Readonly<Record<string, unknown>>): string | null {
  const field = APPROVAL_KINDS[kind].subjectField;
  if (field === null) return null;
  const v = payload[field];
  return typeof v === 'string' ? v : null;
}

/** What the record shows now: a PENDING request past its expiry reads as EXPIRED, without anything having to run. */
export function effectiveApprovalStatus(a: { readonly status: ApprovalStatus; readonly expiresAt: Date }, now: Date): ApprovalStatus {
  return a.status === 'PENDING' && now.getTime() >= a.expiresAt.getTime() ? 'EXPIRED' : a.status;
}

export type DecisionRefusal = 'own_request' | 'names_you' | 'not_pending' | 'expired' | 'payload_changed' | 'not_allowed';

/**
 * Q3, in order: an approver who may not decide this kind, the requester themselves, or the person the payload names is
 * refused; so is a request no longer PENDING, one past its expiry, or one whose payload hash isn't the one the approver
 * was shown. Null: the decision may go ahead. `shownHash` is null for a rejection, which needs no hash.
 */
export function decisionRefusal(
  a: { readonly kind: ApprovalKind; readonly status: ApprovalStatus; readonly expiresAt: Date; readonly requestedBy: string; readonly subjectId: string | null; readonly payloadHash: string },
  approver: { readonly userId: string; readonly role: string },
  shownHash: string | null,
  now: Date,
): DecisionRefusal | null {
  if (!roleHolds(approver.role, APPROVAL_KINDS[a.kind].approvePermission)) return 'not_allowed';
  if (approver.userId === a.requestedBy) return 'own_request';
  if (a.subjectId !== null && approver.userId === a.subjectId) return 'names_you';
  if (a.status !== 'PENDING') return 'not_pending';
  if (effectiveApprovalStatus(a, now) === 'EXPIRED') return 'expired';
  if (shownHash !== null && shownHash !== a.payloadHash) return 'payload_changed';
  return null;
}

const roleHolds = (role: string, permission: PlatformPermission): boolean => isPlatformRole(role) && PLATFORM_ROLE_PERMISSIONS[role].includes(permission);

/** Who could approve a kind at all: active members, with an authenticator, whose role grants its approve permission. */
export interface StaffForApproval {
  readonly id: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly mfaEnrolled: boolean;
}

export function possibleApprovers<T extends StaffForApproval>(kind: ApprovalKind, staff: readonly T[], requestedBy: string, subjectId: string | null): T[] {
  const permission = APPROVAL_KINDS[kind].approvePermission;
  return staff.filter((s) => s.isActive && s.mfaEnrolled && roleHolds(s.role, permission) && s.id !== requestedBy && s.id !== subjectId);
}

/** Q5, no solo bypass (A7): a request can be made only if someone other than its requester and its subject could approve it. */
export const secondPersonAvailable = (kind: ApprovalKind, staff: readonly StaffForApproval[], requestedBy: string, subjectId: string | null): boolean =>
  possibleApprovers(kind, staff, requestedBy, subjectId).length > 0;

/** When a new request expires. */
export const approvalExpiry = (kind: ApprovalKind, now: Date): Date => new Date(now.getTime() + APPROVAL_KINDS[kind].ttlMs);
