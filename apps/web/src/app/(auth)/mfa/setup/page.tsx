import { buttonClass, Card, Check } from '@univarse/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { loadSession, signedInOrThrow } from '@/lib/session';
import { MfaSetup } from './MfaSetup';

export const metadata: Metadata = { title: 'Turn on two-step sign-in' };

/** W13. Reachable from an enrolment-only (restricted) session, or voluntarily from the workspace. */
export default async function MfaSetupPage() {
  const me = signedInOrThrow(await loadSession());

  if (me.mfa && !me.restricted) {
    return (
      <Card className="auth__card">
        <div className="done">
          <span className="done__mark">
            <Check size={32} />
          </span>
          <h1 id="auth-heading" className="auth__heading">
            Two-step sign-in is already on
          </h1>
          <p className="auth__sub">Your account asks for a code from your phone each time you sign in.</p>
          <Link className={buttonClass('action', true)} href="/workspace">
            Back to my workspace
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <MfaSetup
      required={me.restricted}
      leaveLater={
        me.restricted ? (
          <div className="auth__more">
            <p>Not now? You can sign out and finish this later.</p>
            <div>
              <LogoutButton variant="plain" />
            </div>
          </div>
        ) : null
      }
    />
  );
}
