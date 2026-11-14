import { messageFor } from '@univarse/contracts';
import { Card, Notice } from '@univarse/ui';
import type { ReactNode } from 'react';
import { brandStyle, logoUrl, tenantProfile } from '@/lib/tenant';

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
  const { profile, code, suspended } = await tenantProfile();
  const b = profile?.branding ?? suspended;
  return (
    <div className="auth" style={b?.primaryColor && b.textColor ? brandStyle(b.primaryColor, b.textColor) : undefined}>
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
              {profile.branding.logoSha256 ? <img className="auth__logo" src={logoUrl(profile.branding.logoSha256)} alt="" /> : null}
              <p className="auth__institution">{profile.legalName}</p>
              <p className="auth__lede">
                Your {KIND[profile.type] ?? 'institution'} account for courses, fees, results and everything in between.
              </p>
            </div>
            <div className="auth__panel">{children}</div>
          </>
        ) : suspended ? (
          // Spec 0037 Q8: the institution still leads; the page says plainly that it's paused, and who can help.
          <>
            <div className="auth__hero">
              <p className="auth__institution">{suspended.legalName}</p>
            </div>
            <div className="auth__panel">
              <Card className="auth__card auth__card--paused">
                <span className="auth__paused-mark" aria-hidden="true" />
                <h1 id="paused-heading" className="auth__heading">
                  Temporarily unavailable
                </h1>
                <p className="auth__sub">{messageFor('tenant.suspended')}</p>
                <p className="auth__paused-note">Your account and records are safe. Nothing is lost while it’s paused.</p>
              </Card>
            </div>
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
