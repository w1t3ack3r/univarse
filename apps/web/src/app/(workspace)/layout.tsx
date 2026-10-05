import type { ReactNode } from 'react';
import { LogoutButton } from '@/components/LogoutButton';
import { NavLinks } from '@/components/NavLinks';
import { StepUpProvider } from '@/components/StepUp';
import { buildNav, NAV } from '@/lib/nav';
import { serverApi } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { tenantProfile } from '@/lib/tenant';

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
  const [{ profile }, products] = await Promise.all([tenantProfile(), serverApi<{ data: string[] }>('/api/v1/products')]);
  const nav = buildNav(NAV, me.permissions, products.body?.data ?? ['core']);

  return (
    <StepUpProvider hasMfa={me.mfa}>
      <div className="ws">
        <aside className="ws__rail uv-on-deep">
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
            <span className="ws__inst ws__inst--phone">{profile?.legalName}</span>
            <div className="plate">
              <span className="plate__initials" aria-hidden="true">
                {initials(me.displayName)}
              </span>
              <span className="plate__text">
                <span className="plate__name" data-testid="user-name">
                  {me.displayName}
                </span>
                <span className="plate__id">{me.username}</span>
              </span>
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
