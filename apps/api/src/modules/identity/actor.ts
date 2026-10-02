import { PERMISSIONS, type Permission } from '@univarse/contracts';

export interface Grant {
  readonly permission: Permission;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly roleKey: string;
}

/** The authenticated caller for one request. Always bound to exactly one tenant. */
export interface Actor {
  readonly tenantId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly username: string;
  readonly displayName: string;
  readonly mfaAt: Date | null;
  /** Enrolment-only session (spec 0001 M8): may reach only @AllowRestricted routes. */
  readonly restricted: boolean;
  /** Last step-up on THIS session (spec 0001 S1/S6). */
  readonly stepUpAt: Date | null;
  readonly grants: readonly Grant[];
}

/** True when the user holds any permission that requires MFA (docs/08 §3.2). */
export const needsMfa = (grants: readonly Grant[]): boolean => grants.some((g) => isPrivileged(g.permission));

/** Institution-wide permission check. Resource-scoped checks (faculty/department) arrive with those modules. */
export const canInstitutionWide = (actor: Actor, permission: Permission): boolean =>
  actor.grants.some((g) => g.permission === permission && g.scopeType === 'INSTITUTION');

export const isPrivileged = (permission: Permission): boolean =>
  (PERMISSIONS[permission] as { privileged?: boolean }).privileged === true;

/** Step-up window (spec 0001 S1). */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

export const requiresStepUp = (permission: Permission): boolean =>
  (PERMISSIONS[permission] as { stepUp?: boolean }).stepUp === true;

export const hasFreshStepUp = (actor: Pick<Actor, 'stepUpAt'>, now: Date): boolean =>
  actor.stepUpAt !== null && now.getTime() - actor.stepUpAt.getTime() <= STEP_UP_WINDOW_MS && actor.stepUpAt <= now;

export type SessionClass = 'STUDENT' | 'STAFF' | 'PRIVILEGED';

/** docs/08 §3.3 session lifetimes by user type. */
export const SESSION_LIFETIMES: Record<SessionClass, { idleMin: number; absoluteHours: number }> = {
  STUDENT: { idleMin: 60, absoluteHours: 12 },
  STAFF: { idleMin: 30, absoluteHours: 10 },
  PRIVILEGED: { idleMin: 15, absoluteHours: 8 },
};

export function sessionClassFor(roleKeys: readonly string[], grants: readonly Grant[]): SessionClass {
  if (grants.some((g) => isPrivileged(g.permission))) return 'PRIVILEGED';
  if (roleKeys.some((k) => k !== 'STUDENT' && k !== 'APPLICANT')) return 'STAFF';
  return 'STUDENT';
}
