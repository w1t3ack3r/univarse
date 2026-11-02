'use client';

import { Button, LogOut } from '@univarse/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { StepUpProvider } from './step-up';

export interface Me {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: string;
  readonly state: 'enrol' | 'recovery-codes' | 'full';
  readonly permissions: readonly string[];
}

/** The platform's role names, as staff read them. */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  OWNER: 'Owner',
  SUPER_ADMIN: 'Super admin',
  SUPPORT: 'Support',
  FINANCE: 'Finance',
  READ_ONLY: 'Read only',
};

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside ConsoleShell');
  return me;
}

/**
 * Every signed-in page (spec 0028 Q16). It asks the platform API who this is on every load: no session, or one that
 * hasn't finished TOTP, goes where it must (sign in, or set up). Nothing renders until the answer, so no page ever
 * shows a moment of content it shouldn't.
 */
export function ConsoleShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState<ApiError | null>(null);

  useEffect(() => {
    let live = true;
    api<Me>('GET', '/me')
      .then((m) => {
        if (!live) return;
        if (m.state !== 'full') router.replace('/setup');
        else setMe(m);
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 401) router.replace('/sign-in');
        else setFailed(err instanceof ApiError ? err : new ApiError(0, undefined, undefined));
      });
    return () => {
      live = false;
    };
  }, [router]);

  if (failed) {
    return (
      <div className="pc-page" role="alert">
        <p className="pc-card__lead">{failed.message}</p>
      </div>
    );
  }
  if (!me) return <PageSkeleton />;
  return (
    <MeContext.Provider value={me}>
      <StepUpProvider>
        <div className="pc-page">
          <SignedInHeader me={me} />
          {children}
        </div>
      </StepUpProvider>
    </MeContext.Provider>
  );
}

function SignedInHeader({ me }: { me: Me }) {
  const router = useRouter();
  const path = usePathname();
  const [leaving, setLeaving] = useState(false);
  const tabs = [
    { href: '/', label: 'Overview' },
    { href: '/account', label: 'Your account' },
    ...(me.permissions.includes('platform.staff.read') ? [{ href: '/staff', label: 'Staff' }] : []),
  ];
  const signOut = () => {
    setLeaving(true);
    void api('POST', '/auth/logout')
      .catch(() => undefined)
      .finally(() => router.replace('/sign-in'));
  };
  return (
    <header className="pc-head">
      <div className="pc-head__who">
        <p className="pc-head__name">{me.displayName}</p>
        <p className="pc-head__meta">
          <span className="pc-role">{ROLE_LABEL[me.role] ?? me.role}</span>
          <span className="pc-head__email">{me.email}</span>
        </p>
      </div>
      <Button type="button" variant="quiet" onClick={signOut} pending={leaving}>
        {leaving ? 'Signing out…' : 'Sign out'}
        {leaving ? null : <LogOut size={18} />}
      </Button>
      <nav className="pc-tabs" aria-label="Console">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="pc-tabs__tab"
            aria-current={path === t.href ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** While the platform API answers: the page's shape, no content. */
export function PageSkeleton() {
  return (
    <div className="pc-page" aria-busy="true" aria-label="Loading">
      <div className="pc-skeleton pc-skeleton--head" />
      <div className="pc-skeleton pc-skeleton--body" />
    </div>
  );
}
