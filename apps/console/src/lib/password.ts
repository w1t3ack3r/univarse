import type { ApiError } from './api';

/** Spec 0028 Q6: what a console password must be, said before anyone types one. */
export const PASSWORD_HINT =
  'At least 12 characters. A short phrase works well. Not a common password, and not your name or email.';

const PROBLEM: Readonly<Record<string, string>> = {
  too_short: 'Use at least 12 characters.',
  too_long: 'Use at most 128 characters.',
  too_common: 'That password is too common. Choose something less guessable.',
  contains_personal_info: 'Don’t use your name or email in your password.',
};

/** The password field's error for a 422 auth.password_rejected, or undefined for any other error. */
export function passwordError(err: ApiError): string | undefined {
  if (err.code !== 'auth.password_rejected') return undefined;
  const first = err.fieldErrors.find((f) => f.path === 'password');
  return (first && PROBLEM[first.code]) ?? 'That password doesn’t meet the rules above.';
}
