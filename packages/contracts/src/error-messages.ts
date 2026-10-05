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
  'request.invalid': 'Some details are missing or not valid.',
  'request.rate_limited': 'Too many attempts. Wait a little and try again.',
  'request.method_not_allowed': "That action isn't allowed here.",
  'request.too_large': 'That is too large to send.',
  'request.unsupported_media_type': "That file type isn't supported.",
  'request.error': 'Something went wrong. Please try again.',
  'server.not_ready': 'UniVarse is starting up. Try again in a moment.',
  'server.internal': 'Something went wrong on our side. Please try again.',
  // Client-side only: the request never reached the server.
  'network.offline': "You seem to be offline. Check your connection and try again.",
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
