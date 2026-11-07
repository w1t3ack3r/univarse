/**
 * Spec 0031 Q12: how much a security event needs a person. Pure, so the page can lead with what matters. An event not
 * in this table reads as `watch`: a new event is never quietly the lowest level. The list of events is the API's
 * (`SECURITY_EVENTS`); a test there requires each to be classified here.
 */
export const SECURITY_LEVELS = ['act', 'watch', 'note'] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];

const LEVELS: Readonly<Record<string, SecurityLevel>> = Object.freeze({
  'files.scan.malware_detected': 'act',
  'db.rls_violation': 'act',
  'platform.audit.chain_broken': 'act',
  'access.route_undeclared': 'act',
  'access.step_up_on_public_route': 'act',
  'products.route_undeclared': 'act',
  'platform.route_undeclared': 'act',
  'platform.mail.failed': 'act',

  'auth.account.locked': 'watch',
  'auth.session.invalid_token': 'watch',
  'auth.step_up.failed': 'watch',
  'http.csrf_rejected': 'watch',
  'platform.allowlist_refused': 'watch',
  'platform.account.locked': 'watch',
  'platform.session.invalid_token': 'watch',
  'platform.step_up.failed': 'watch',

  'auth.rate_limited': 'note',
  'platform.rate_limited': 'note',
  'platform.staff.changed': 'note',
});

export const securityLevel = (event: string): SecurityLevel => LEVELS[event] ?? 'watch';
export const isClassifiedSecurityEvent = (event: string): boolean => Object.hasOwn(LEVELS, event);
