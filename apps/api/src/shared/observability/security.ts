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
] as const;

export type SecurityEvent = (typeof SECURITY_EVENTS)[number];

/** The fields for a security line: `event`, `stream: "security"`, plus details (ids only, never secrets). */
export const securityFields = (event: SecurityEvent, details: Record<string, unknown> = {}) => ({ event, stream: 'security' as const, ...details });

/** A rate-limit bucket's NAME only: keys embed the IP and the identifier, which must not be logged. */
export const bucketName = (key: string): string => key.split(':').slice(1, 3).join(':');
