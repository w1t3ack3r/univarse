import { redirect } from 'next/navigation';
import { serverGet } from './server-api';
import { ApiUnavailableError, checkSession, type Me, type MeAnswer, type SessionCheck } from './session-check';

export type { Me } from './session-check';

/** Asks the API who is signed in. Never throws for a failed call: the answer says what happened. */
export async function loadSession(): Promise<SessionCheck> {
  let answer: MeAnswer;
  try {
    answer = await serverGet((api) => api.GET('/api/v1/auth/me'));
  } catch {
    answer = 'unreachable';
  }
  return checkSession(answer);
}

/**
 * Spec 0005 W7: the signed-in user, a redirect, or the error boundary. Nothing personal renders before
 * this resolves. Only a 401 goes to login; an API failure throws to the nearest error.tsx with its
 * support reference, so a valid session never looks signed out. A restricted (enrolment-only) session
 * is sent to MFA setup.
 */
export async function requireSession(): Promise<Me> {
  const me = signedInOrThrow(await loadSession());
  if (me.restricted) redirect('/mfa/setup');
  return me;
}

/** A signed-in user (restricted or not); signed out → login; API trouble → error boundary. */
export function signedInOrThrow(check: SessionCheck): Me {
  if (check.kind === 'signed-out') redirect('/login');
  if (check.kind === 'unavailable') throw new ApiUnavailableError(check.code, check.requestId);
  return check.me;
}
