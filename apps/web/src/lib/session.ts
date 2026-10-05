import { redirect } from 'next/navigation';
import { serverApi } from './server-api';

export interface Me {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly mfa: boolean;
  readonly restricted: boolean;
  readonly permissions: readonly string[];
}

/**
 * Spec 0005 W7: the signed-in user, or a redirect. Nothing personal renders before this resolves.
 * A restricted (enrolment-only) session is sent to MFA setup.
 */
export async function requireSession(): Promise<Me> {
  const res = await serverApi<Me>('/api/v1/auth/me');
  if (res.status !== 200 || !res.body) redirect('/login');
  if (res.body.restricted) redirect('/mfa/setup');
  return res.body;
}
