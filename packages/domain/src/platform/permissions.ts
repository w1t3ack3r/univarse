/**
 * Spec 0028 Q12 (spec 0025 A5): the platform's permissions, the five platform roles' grants, and the one rule that
 * decides a platform request. Pure, so the whole matrix is tested; the platform API's guard is its only caller.
 * Each later slice adds its own permissions here, with its routes.
 */
export const PLATFORM_PERMISSIONS = [
  'platform.self',
  'platform.staff.read',
  'platform.staff.manage',
  'platform.audit.read',
  'platform.audit.verify',
  'platform.security.read',
  'platform.access_review.read',
  'platform.access_review.attest',
  'platform.tenant.read',
  'platform.tenant.edit',
  'platform.tenant.entitlements',
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const PLATFORM_ROLES = ['OWNER', 'SUPER_ADMIN', 'SUPPORT', 'FINANCE', 'READ_ONLY'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** What each permission covers, and whether it needs a step-up on the session within STEP_UP_WINDOW_MS. */
export const PLATFORM_PERMISSION_CATALOG: Readonly<Record<PlatformPermission, { readonly stepUp: boolean; readonly description: string }>> = Object.freeze({
  'platform.self': { stepUp: false, description: "One's own account: who you are, your sessions, signing out." },
  'platform.staff.read': { stepUp: false, description: 'The list of platform staff: names, roles, status, last sign-in.' },
  'platform.staff.manage': { stepUp: true, description: 'Invite, reinstate or deactivate staff, change a role, reset MFA (OWNER only).' },
  'platform.audit.read': { stepUp: false, description: 'The platform audit log and the chain verification results. Viewing it is itself audited.' },
  'platform.audit.verify': { stepUp: false, description: 'Start a verification of the audit chain.' },
  'platform.security.read': { stepUp: false, description: 'Counts of security events, per institution and for the platform.' },
  'platform.access_review.read': { stepUp: false, description: 'The monthly access reviews, and whether one is due.' },
  'platform.access_review.attest': { stepUp: true, description: "Attest this month's access review (OWNER only)." },
  'platform.tenant.read': { stepUp: false, description: 'The institutions: list, detail and search. No personal data.' },
  'platform.tenant.edit': { stepUp: true, description: "An institution's profile, regulatory profile and branding." },
  'platform.tenant.entitlements': { stepUp: true, description: 'Grant or revoke a product for an institution.' },
});

/** The roles' grants, in code (A5): a change here is a reviewed change, never data. Only OWNER manages staff. */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<Record<PlatformRole, readonly PlatformPermission[]>> = Object.freeze({
  OWNER: [
    'platform.self',
    'platform.staff.read',
    'platform.staff.manage',
    'platform.audit.read',
    'platform.audit.verify',
    'platform.security.read',
    'platform.access_review.read',
    'platform.access_review.attest',
    'platform.tenant.read',
    'platform.tenant.edit',
    'platform.tenant.entitlements',
  ],
  SUPER_ADMIN: ['platform.self', 'platform.staff.read', 'platform.audit.read', 'platform.audit.verify', 'platform.security.read', 'platform.access_review.read', 'platform.tenant.read', 'platform.tenant.edit', 'platform.tenant.entitlements'],
  SUPPORT: ['platform.self', 'platform.tenant.read'],
  FINANCE: ['platform.self', 'platform.tenant.read'],
  READ_ONLY: ['platform.self', 'platform.staff.read', 'platform.audit.read', 'platform.security.read', 'platform.access_review.read', 'platform.tenant.read'],
});

/** Spec 0028 Q11: a step-up counts for 5 minutes on the session that made it. */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

export const isPlatformPermission = (p: string): p is PlatformPermission => (PLATFORM_PERMISSIONS as readonly string[]).includes(p);
export const isPlatformRole = (r: string): r is PlatformRole => (PLATFORM_ROLES as readonly string[]).includes(r);

/** All the rule may see of the signed-in member and their session. */
export interface PlatformSubject {
  readonly role: string;
  readonly isActive: boolean;
  /** When this session passed its second factor; null until it has. */
  readonly mfaAt: Date | null;
  /** An enrolment-only session (no confirmed factor yet). */
  readonly restricted: boolean;
  readonly stepUpAt: Date | null;
}

/**
 * Why a request is refused. `hidden` answers 404, as an unknown route (spec 0025: out of scope is 404); the other two
 * tell a member who holds the permission what to do next.
 */
export type PlatformRefusal = 'hidden' | 'enrolment_required' | 'step_up_required';
export type PlatformDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: PlatformRefusal };

const ALLOW: PlatformDecision = Object.freeze({ allowed: true });
const refuse = (reason: PlatformRefusal): PlatformDecision => ({ allowed: false, reason });

/**
 * The whole rule, in order: an inactive member, an unknown role, or a permission the role doesn't grant is hidden; a
 * session that hasn't passed TOTP (enrolment-only, or no second factor) is sent to enrol; a permission flagged step-up
 * needs a step-up on this session within the window. Nothing else decides platform access.
 */
export function evaluatePlatform(subject: PlatformSubject, permission: PlatformPermission, now: Date = new Date()): PlatformDecision {
  if (!subject.isActive || !isPlatformRole(subject.role)) return refuse('hidden');
  if (!PLATFORM_ROLE_PERMISSIONS[subject.role].includes(permission)) return refuse('hidden');
  if (subject.restricted || subject.mfaAt === null) return refuse('enrolment_required');
  if (PLATFORM_PERMISSION_CATALOG[permission].stepUp && !hasFreshPlatformStepUp(subject, now)) return refuse('step_up_required');
  return ALLOW;
}

/** A step-up on this session, no older than the window, and not dated in the future. */
export function hasFreshPlatformStepUp(subject: Pick<PlatformSubject, 'stepUpAt'>, now: Date = new Date()): boolean {
  if (!subject.stepUpAt) return false;
  const age = now.getTime() - subject.stepUpAt.getTime();
  return age >= 0 && age <= STEP_UP_WINDOW_MS;
}
