// Spec 0012 OB7: security events go to their own stream (longer retention, docs/14 §2). They are logged
// by the code that detects them, at warn (D5), or error for misdeclared routes (a bug that refuses
// every request). Logs are never sampled, so these lines exist whatever the trace sampler decides.

export const SECURITY_EVENTS = [
  'auth.account.locked',
  'auth.rate_limited',
  'auth.session.invalid_token',
  'auth.step_up.failed',
  'http.csrf_rejected',
  'files.scan.malware_detected',
  'access.route_undeclared',
  'access.step_up_on_public_route',
  'products.route_undeclared',
  // Spec 0031 Q11: PostgreSQL refused a row or an object: RLS or a role's grants did their job, on something that tried.
  'db.rls_violation',
  // Spec 0027 P4: a platform API request from outside the console's allowlist (answered 404).
  'platform.allowlist_refused',
  // Spec 0028 Q9, Q11, Q12, Q13, Q15: the console's sign-in, step-up, routes, mail and staff changes.
  'platform.account.locked',
  'platform.session.invalid_token',
  'platform.step_up.failed',
  'platform.rate_limited',
  'platform.mail.failed',
  'platform.route_undeclared',
  'platform.staff.changed',
  // Spec 0031 Q6: the audit chain failed verification (a Sev-1 candidate, docs/14 §5).
  'platform.audit.chain_broken',
  // Spec 0032 T31: someone said an address change wasn't theirs.
  'identity.email_change.undone',
  // Spec 0037 Q3 (T24): a two-person request made, and its decision.
  'platform.approval.requested',
  'platform.approval.decided',
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

/** The fields for a security line: `event`, `stream: "security"`, plus details (ids only, never secrets). */
export const securityFields = (event: SecurityEvent, details: Record<string, unknown> = {}) => ({ event, stream: 'security' as const, ...details });

/** A rate-limit bucket's NAME only: keys embed the IP and the identifier, which must not be logged. */
export const bucketName = (key: string): string => key.split(':').slice(1, 3).join(':');
