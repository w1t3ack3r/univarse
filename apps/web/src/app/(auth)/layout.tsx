import { messageFor } from '@univarse/contracts';
import { Card, Notice } from '@univarse/ui';
import type { ReactNode } from 'react';
import { tenantProfile } from '@/lib/tenant';

const KIND: Record<string, string> = {
  UNIVERSITY: 'university',
  POLYTECHNIC: 'polytechnic',
  COLLEGE_OF_EDUCATION: 'college of education',
};

/**
 * Sign-in shell (direction contract: .impeccable/surfaces/src-app.md). The institution leads; UniVarse
 * is the trust mark. Each page renders its own task card as `children`.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const { profile, code } = await tenantProfile();
  return (
    <div className="auth">
      <header className="auth__top">
        <span className="uv-pill auth__trust">
          <img src="/brand/icon-deep.svg" alt="" width={18} height={18} />
          Secured by UniVarse
        </span>
      </header>
      <main id="main" className="auth__body">
        {profile ? (
          <>
            <div className="auth__hero">
              <p className="auth__institution">{profile.legalName}</p>
              <p className="auth__lede">
                Your {KIND[profile.type] ?? 'institution'} account for courses, fees, results and everything in between.
              </p>
            </div>
            <div className="auth__panel">{children}</div>
          </>
        ) : (
          <Card>
            <Notice>{messageFor(code)}</Notice>
          </Card>
        )}
      </main>
      <footer className="auth__foot">UniVarse keeps your account safe with encrypted sessions and two-step sign-in.</footer>
    </div>
  );
}
