// Spec 0031 Q4, Q13: what staff read instead of machine names. A test requires every audit action and security event
// the code writes to have words here. An unknown one still shows, as its raw name: the log never hides a row.

/** The audit log's actions, in plain words. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'platform.auth.activated': 'Activated their account',
  'platform.auth.password_accepted': 'Entered a correct password',
  'platform.auth.signed_in': 'Signed in',
  'platform.auth.signed_out': 'Signed out',
  'platform.auth.failed': 'Failed a sign-in check',
  'platform.auth.account_locked': 'Account locked after repeated failures',
  'platform.auth.stepped_up': 'Confirmed their identity',
  'platform.auth.recovery_code_used': 'Used a recovery code',
  'platform.auth.password_reset_requested': 'Asked to reset their password',
  'platform.auth.password_reset': 'Reset their password',
  'platform.session.ended': 'Ended a session',
  'platform.mfa.enrolment_started': 'Started authenticator setup',
  'platform.mfa.enrolled': 'Set up their authenticator',
  'platform.mfa.recovery_codes_saved': 'Saved their recovery codes',
  'platform.mfa.recovery_codes_regenerated': 'Made new recovery codes',
  'platform.staff.invited': 'Invited a staff member',
  'platform.staff.role_changed': "Changed a staff member's role",
  'platform.staff.deactivated': "Removed a staff member's access",
  'platform.staff.reinstated': "Restored a staff member's access",
  'platform.staff.mfa_reset': "Reset a staff member's authenticator",
  'platform.contact.change_requested': 'Asked to change an address',
  'platform.contact.changed': 'Changed an address',
  'platform.contact.corrected_unactivated': "Corrected an address before activation",
  'platform.contact.undone': 'Undid an address change',
  'platform.tenant.profile_changed': "Changed an institution's profile",
  'platform.tenant.regulatory_changed': "Changed an institution's regulatory details",
  'platform.tenant.branding_changed': "Changed an institution's branding",
  'platform.tenant.product_granted': 'Granted a product',
  'platform.tenant.product_revoked': 'Revoked a product',
  'platform.owner.created': 'Created the first owner',
  'platform.owner.recovered': 'Recovered the owner account',
  'platform.audit.viewed': 'Viewed the audit log',
  'platform.audit.verified': 'Checked the audit log',
  'platform.access_review.attested': 'Attested the access review',
  'tenant.drill_created': 'Created a restore-drill institution',
  'drill.shred_values_written': 'Wrote a restore drill’s test values',
  'crypto.legacy_v1.migrated': 'Migrated old encrypted data',
  'crypto.tenant_key.created': "Created an institution's data key",
  'crypto.tenant_key.rotated': "Rotated an institution's data key",
  'crypto.tenant_key.destroyed': "Destroyed an institution's data key",
  'crypto.tenant_key.reapplied': 'Reapplied a key destruction',
  'crypto.tenant_key.adopted': 'Adopted a recorded key destruction',
  'crypto.kek.rewrapped': 'Re-wrapped a data key',
  'crypto.ledger.waived': 'Waived the shred ledger guarantee',
});

export const auditActionLabel = (action: string): string => AUDIT_ACTION_LABELS[action] ?? action;

/** The audit log's filter: groups of actions, by what a person is looking for. */
export const AUDIT_ACTION_GROUPS: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: 'platform.auth', label: 'Sign-ins and passwords' },
  { value: 'platform.mfa', label: 'Authenticators' },
  { value: 'platform.session', label: 'Sessions' },
  { value: 'platform.staff', label: 'Staff changes' },
  { value: 'platform.contact', label: 'Address changes' },
  { value: 'platform.tenant', label: 'Institution changes' },
  { value: 'platform.owner', label: 'The owner account' },
  { value: 'platform.audit', label: 'Viewing and checking this log' },
  { value: 'platform.access_review', label: 'Access reviews' },
  { value: 'crypto', label: 'Encryption keys' },
]);

/** The security page: what an event is, and what a person should do about it. */
export const SECURITY_EVENT_TEXT: Readonly<Record<string, { readonly label: string; readonly todo: string }>> = Object.freeze({
  'files.scan.malware_detected': { label: 'A malware scan found something in an upload', todo: 'The file was blocked. Find out who uploaded it, and tell the institution.' },
  'db.rls_violation': { label: 'The database refused a request', todo: 'Isolation held, but something tried to cross it. Treat it as a possible attack or a serious bug until you know which.' },
  'identity.email_change.undone': { label: 'An address change was undone', todo: 'Someone said a change wasn’t theirs. Treat the account as taken over until you know: check the audit log and speak to the person.' },
  'platform.audit.chain_broken': { label: 'The audit log failed its check', todo: 'Treat it as a Sev-1 candidate: follow the incident runbook, and change nothing.' },
  'access.route_undeclared': { label: 'A route has no declared permission', todo: 'A code bug. It refuses every request, so fix it and release.' },
  'access.step_up_on_public_route': { label: 'A public route asks for a step-up', todo: 'A code bug. Fix it and release.' },
  'products.route_undeclared': { label: 'A route has no declared product', todo: 'A code bug. It refuses every request, so fix it and release.' },
  'platform.route_undeclared': { label: 'A console route has no declared access', todo: 'A code bug. It refuses every request, so fix it and release.' },
  'platform.mail.failed': { label: 'Console mail could not be delivered', todo: 'Someone may be missing a code or a security notice. Check the mail settings.' },
  'auth.account.locked': { label: 'An account locked after failed sign-ins', todo: 'One is ordinary. Many at one institution may be an attack on its accounts.' },
  'auth.session.invalid_token': { label: 'A session token was refused', todo: 'Usually an old session. A spike may be someone testing stolen tokens.' },
  'auth.step_up.failed': { label: 'An identity confirmation failed', todo: 'Repeats on one account may mean someone else is using it.' },
  'http.csrf_rejected': { label: 'A forged request was refused', todo: 'It was stopped. A pattern may mean someone is being targeted.' },
  'platform.allowlist_refused': { label: 'The console was reached from outside its allowed addresses', todo: 'It was refused. Find out who is probing it if this keeps happening.' },
  'platform.account.locked': { label: 'A staff account locked after failed sign-ins', todo: 'Check with the staff member. If it wasn’t them, reset their password.' },
  'platform.session.invalid_token': { label: 'A staff session token was refused', todo: 'Usually an old session. Repeats may be someone testing a stolen one.' },
  'platform.step_up.failed': { label: 'A staff identity confirmation failed', todo: 'Check with the staff member if it repeats.' },
  'auth.rate_limited': { label: 'Sign-in attempts were slowed down', todo: 'Nothing, unless it grows.' },
  'platform.rate_limited': { label: 'Console requests were slowed down', todo: 'Nothing, unless it grows.' },
  'platform.staff.changed': { label: 'A staff member’s access changed', todo: 'Check the audit log if you weren’t expecting it.' },
});

export const securityEventText = (event: string): { readonly label: string; readonly todo: string } =>
  SECURITY_EVENT_TEXT[event] ?? { label: event, todo: 'This event has no guidance yet. Treat it with care.' };
