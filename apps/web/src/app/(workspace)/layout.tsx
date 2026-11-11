import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/LogoutButton';
import { NavLinks } from '@/components/NavLinks';
import { StepUpProvider } from '@/components/StepUp';
import { buildNav, NAV } from '@/lib/nav';
import { serverGet } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { brandStyle, logoUrl, tenantProfile } from '@/lib/tenant';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/**
 * Spec 0005 W6. Desktop: deep-green rail. Phone: thumb bar within reach (direction contract).
 * Navigation from permissions + active products; the name plate is the person's fixed furniture.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const me = await requireSession();
  const [{ profile }, products] = await Promise.all([tenantProfile(), serverGet((api) => api.GET('/api/v1/products'))]);
  const nav = buildNav(NAV, me.permissions, products.data?.data ?? ['core']);
  const b = profile?.branding;
  const logo = b?.logoSha256 ? logoUrl(b.logoSha256) : null;
  // A light colour carries the ink; a dark one carries white (the domain chose which, at 4.5:1 or more).
  const brand = b?.primaryColor && b.textColor ? { primaryColor: b.primaryColor, textColor: b.textColor, tone: b.textColor.toUpperCase() === '#FFFFFF' ? 'dark' : 'light' } : null;

  return (
    <StepUpProvider hasMfa={me.mfa}>
      <div className="ws" style={brand ? brandStyle(brand.primaryColor, brand.textColor) : undefined} data-brand={brand?.tone}>
        <aside className={brand?.tone === 'light' ? 'ws__rail' : 'ws__rail uv-on-deep'}>
          {logo ? <img className="ws__logo" src={logo} alt="" /> : null}
          <p className="ws__identity" data-testid="institution">
            {profile?.legalName}
          </p>
          <nav aria-label="Workspace">
            <NavLinks items={nav} />
          </nav>
          <p className="ws__rail-foot ws__secured">
            <img src="/brand/icon-lime.svg" alt="" width={18} height={18} />
            Secured by UniVarse
          </p>
        </aside>
        <div>
          <header className="ws__top">
            <span className="ws__inst ws__inst--phone">
              {logo ? <img className="ws__logo ws__logo--phone" src={logo} alt="" /> : null}
              <span className="ws__inst-name">{profile?.legalName}</span>
            </span>
            <div className="plate">
              <Link className="plate__link" href="/workspace/account" aria-label={`Your account: ${me.displayName}`}>
                <span className="plate__initials" aria-hidden="true">
                  {initials(me.displayName)}
                </span>
                <span className="plate__text">
                  <span className="plate__name" data-testid="user-name">
                    {me.displayName}
                  </span>
                  <span className="plate__id">{me.username}</span>
                </span>
              </Link>
              <LogoutButton variant="quiet" compact />
            </div>
          </header>
          <main id="main" className="ws__main">
            {children}
          </main>
        </div>
        <nav aria-label="Workspace" className="ws__thumb">
          <NavLinks items={nav} />
        </nav>
      </div>
    </StepUpProvider>
  );
}
