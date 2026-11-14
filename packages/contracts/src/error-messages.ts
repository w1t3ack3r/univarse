// User-facing messages per problem `code` (docs/06 §4, docs/11 §2). The UI maps codes to these and
// never parses `detail`. Every code the API emits must appear here: apps/api error-messages.spec.ts
// fails otherwise. Messages never reveal whether an account exists.

export const ERROR_MESSAGES = {
  'auth.invalid_credentials': 'That username or password is not right.',
  'auth.unauthenticated': 'Your session has ended. Please sign in again.',
  'auth.forbidden': "You don't have access to this.",
  'auth.mfa_invalid': 'That code is not right, or it has expired. Try again.',
  'auth.mfa_required': 'This action needs multi-factor authentication. Set it up to continue.',
  'auth.mfa_enrolment_required': 'Set up multi-factor authentication to continue.',
  'auth.mfa_enrolment_expired': 'Setup took too long. Start again.',
  'auth.mfa_already_enrolled': 'Multi-factor authentication is already set up.',
  'auth.mfa_not_enrolled': 'Multi-factor authentication is not set up.',
  'auth.step_up_required': 'Confirm your identity to continue.',
  'auth.step_up_second_factor_required': 'Enter the code from your authenticator app.',
  'auth.activation_invalid': 'That code is not right, or it has expired. Request a new one.',
  'auth.reset_invalid': 'That code is not right, or it has expired. Request a new one.',
  'auth.password_rejected': "That password doesn't meet the requirements.",
  'tenant.not_found': "We couldn't find this institution. Check the address.",
  'tenant.suspended': 'This institution is temporarily unavailable. Please contact your ICT unit.',
  'product.not_entitled': 'This product is not included in your plan.',
  'product.core_required': 'This product is always on.',
  'product.changed': 'Settings changed while you were editing. Reload and try again.',
  'resource.not_found': "We couldn't find that.",
  'tenant.closed': 'This institution is archived, so it can’t be changed.',
  'tenant.type_locked': 'The type can’t change once an institution is live.',
  'tenant.color_contrast': 'Text can’t be read on that colour. Choose a darker or lighter one.',
  'tenant.logo_refused': 'That logo can’t be used. It must be a PNG or WebP, at most 256 KB and 1024 × 1024.',
  'tenant.product_always_on': 'Core is always on.',
  'tenant.confirm_mismatch': 'Type the institution’s subdomain exactly to confirm.',
  'tenant.slug_invalid': 'Use 3 to 40 lower-case letters, digits and single hyphens, starting with a letter.',
  'tenant.slug_reserved': 'That subdomain is kept for UniVarse’s own use. Choose another.',
  'tenant.slug_taken': 'Another institution already uses that subdomain.',
  'tenant.template_mismatch': 'That template is for another type of institution.',
  'tenant.product_unknown': 'One of those products doesn’t exist.',
  'provisioning.unavailable': 'Provisioning isn’t set up on this platform yet.',
  'provisioning.not_failed': 'This provisioning hasn’t failed, so there’s nothing to resume.',
  'tenant.not_onboarding': 'Only an institution that is onboarding can go live.',
  'tenant.go_live_incomplete': 'Every item on the checklist has to pass first.',
  'tenant.dpa_date': 'The date signed can’t be in the future.',
  'contact.code_invalid': 'That code isn’t right, or it has expired.',
  'contact.undo_invalid': 'That undo code isn’t right, or it has expired.',
  'contact.too_many': 'Too many address changes. Try again in an hour.',
  'contact.same_address': 'That’s already the address on this account.',
  'contact.member_inactive': 'Restore their access first.',
  'contact.address_taken': 'That address already belongs to someone.',
  'contact.own_account': 'Change your own address in Your account.',
  'staff.email_taken': 'Someone on the platform team already uses that email address.',
  'staff.own_account': "You can't change your own role or access. Ask another owner.",
  'staff.last_owner': 'The platform must keep at least one active owner.',
  'staff.owner_needs_approval': 'Making someone an owner needs a second person. Request an approval instead.',
  'staff.owner_by_approval': 'Invite them with another role, then request an approval to make them an owner.',
  'approval.no_second_person': 'This needs a second person, and nobody else can approve it yet.',
  'approval.own_request': "You can't decide your own request. Another member has to.",
  'approval.names_you': "This request is about you, so you can't decide it.",
  'approval.not_pending': 'This request has already been decided, cancelled or has expired.',
  'approval.expired': 'This request has expired. Ask for a new one.',
  'approval.payload_changed': 'This request isn’t what you were shown. Reload it and check again.',
  'approval.already_pending': 'A request for this is already waiting for a decision.',
  'approval.not_applicable': 'This request no longer applies: nothing would change.',
  'tenant.not_suspendable': 'Only an institution that is live or onboarding can be suspended.',
  'tenant.not_suspended': 'This institution isn’t suspended.',
  'tenant.sessions_ending': 'Its sessions are still being ended. Try again in a minute.',
  'tenant.suspension_note': 'Add a note of 3 to 200 characters. It’s required when the reason is “Other”.',
  'audit.verification_running': 'A verification is already running. It will show here when it finishes.',
  'access_review.changed': 'Someone\'s access changed while you were reviewing. Reload the page and review it again.',
  'access_review.incomplete': 'Mark every member keep or needs a change, then attest.',
  'access_review.already_done': "This month's review has already been attested.",
  'settings.unknown_key': "We couldn't find that setting.",
  'settings.invalid_value': 'Some values are not valid. Check the highlighted fields.',
  'settings.stored_value_invalid': "This setting's saved value is no longer valid. Contact UniVarse support.",
  'file.not_ready': 'This file is still being checked, or was not accepted.',
  'file.too_large': 'That file is too large. The limit is 5 MB.',
  'file.type_not_allowed': 'Only PDF, PNG or JPEG files can be uploaded.',
  'file.quota_exceeded': 'Your institution has run out of space for documents. Contact your ICT unit.',
  'file.upload_incomplete': 'The upload did not finish. Try uploading the file again.',
  'precondition.required': 'Reload the page and try again.',
  'precondition.failed': 'Someone else changed this while you were editing. Here are the latest values.',
  'request.invalid': 'Some details are missing or not valid.',
  'request.invalid_cursor': 'This list has changed since you opened that page. Start again from the first page.',
  'request.rate_limited': 'Too many attempts. Wait a little and try again.',
  'request.csrf_rejected': "That request didn't come from this page. Reload it and try again.",
  'request.method_not_allowed': "That action isn't allowed here.",
  'request.too_large': 'That is too large to send.',
  'request.unsupported_media_type': "That file type isn't supported.",
  'request.error': 'Something went wrong. Please try again.',
  'server.not_ready': 'UniVarse is starting up. Try again in a moment.',
  'server.internal': 'Something went wrong on our side. Please try again.',
  'server.busy': 'UniVarse is very busy right now. Try again in a few seconds.',
  'server.unexpected_response': 'Something went wrong on our side. Please try again in a moment.',
  // Client-side only: the request never reached the server.
  'network.offline': "You seem to be offline. Check your connection and try again.",
  // Server-side only: the web app could not reach the API (connection refused, reset, DNS).
  'network.unreachable': "We couldn't reach UniVarse just now. Try again in a moment.",
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export const FALLBACK_ERROR_MESSAGE = 'Something went wrong. Please try again.';

export const messageFor = (code: string | undefined): string =>
  code !== undefined && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code as ErrorCode] : FALLBACK_ERROR_MESSAGE;

/**
 * Field-level messages for `auth.password_rejected` (`errors[].code`, apps/api password.ts).
 * Warm and plain (apps/web/PRODUCT.md): say what to change, never blame.
 */
export const PASSWORD_PROBLEM_MESSAGES = {
  too_short: 'Make it longer: at least 8 characters, or 12 if your role approves results or manages people.',
  too_long: 'That’s longer than we can accept. Keep it under 128 characters.',
  too_common: 'That password is too easy to guess. Try a short sentence only you would think of.',
  contains_personal_info: 'Leave your name and username out of your password.',
} as const satisfies Record<string, string>;

export const passwordProblemMessage = (code: string): string =>
  Object.hasOwn(PASSWORD_PROBLEM_MESSAGES, code)
    ? PASSWORD_PROBLEM_MESSAGES[code as keyof typeof PASSWORD_PROBLEM_MESSAGES]
    : 'Choose a different password.';
