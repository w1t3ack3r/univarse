'use client';

import type { PlatformChainStatus, PlatformInbox } from '@univarse/contracts';
import { Button, LogOut, Notice, Search } from '@univarse/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { api, ApiError, field } from '../lib/api';
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
          {me.permissions.includes('platform.audit.read') ? <ChainBanner /> : null}
          {children}
        </div>
      </StepUpProvider>
    </MeContext.Provider>
  );
}

/** Spec 0031 Q6: a broken audit chain is seen without anyone asking, on every page, until a later check passes. */
function ChainBanner() {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    api<PlatformChainStatus>('GET', '/audit/verification')
      .then((r) => {
        if (live) setBroken(r.broken);
      })
      .catch(() => undefined); // this banner only ever adds to a page; the audit page itself reports a failed read
    return () => {
      live = false;
    };
  }, []);
  if (!broken) return null;
  return (
    <Notice>
      The audit log failed its last check. Follow the incident runbook, and change nothing. <Link href="/audit">See the audit log</Link>
    </Notice>
  );
}

function SignedInHeader({ me }: { me: Me }) {
  const router = useRouter();
  const path = usePathname();
  const [leaving, setLeaving] = useState(false);
  const inboxCount = useInboxCount(path);
  const tabs = [
    { href: '/', label: 'Overview' },
    { href: '/inbox', label: 'Inbox', count: inboxCount },
    ...(me.permissions.includes('platform.approval.decide') || me.permissions.includes('platform.staff.manage') ? [{ href: '/approvals', label: 'Approvals' }] : []),
    ...(me.permissions.includes('platform.tenant.read') ? [{ href: '/institutions', label: 'Institutions' }, { href: '/notices', label: 'Notices' }] : []),
    { href: '/account', label: 'Your account' },
    ...(me.permissions.includes('platform.staff.read') ? [{ href: '/staff', label: 'Staff' }] : []),
    ...(me.permissions.includes('platform.audit.read') ? [{ href: '/audit', label: 'Audit log' }] : []),
    ...(me.permissions.includes('platform.security.read') ? [{ href: '/security', label: 'Security' }] : []),
    ...(me.permissions.includes('platform.access_review.read') ? [{ href: '/access-review', label: 'Access review' }] : []),
  ];
  const signOut = () => {
    setLeaving(true);
    void api('POST', '/auth/logout')
      .catch(() => undefined)
      .finally(() => router.replace('/sign-in'));
  };
  // Spec 0033 Q8. From 2 characters, as the API takes it. The term goes in the address: an institution's name is public.
  const search = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const q = field(new FormData(e.currentTarget), 'q');
    if (q.length >= 2) router.push(`/institutions?q=${encodeURIComponent(q)}`);
  };

  // On a phone the tabs scroll: the page you're on should be one you can see.
  useEffect(() => {
    document.querySelector('.pc-tabs__tab[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [path]);
  return (
    <header className="pc-head">
      <div className="pc-head__who">
        <p className="pc-head__name">{me.displayName}</p>
        <p className="pc-head__meta">
          <span className="pc-role">{ROLE_LABEL[me.role] ?? me.role}</span>
          <span className="pc-head__email">{me.email}</span>
        </p>
      </div>
      {me.permissions.includes('platform.tenant.read') ? (
        <form role="search" className="pc-search" onSubmit={search}>
          <label className="uv-visually-hidden" htmlFor="pc-search">
            Find an institution
          </label>
          <Search size={18} />
          <input id="pc-search" name="q" type="search" placeholder="Find an institution" autoComplete="off" spellCheck={false} maxLength={80} />
        </form>
      ) : null}
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
            aria-current={path === t.href || (t.href !== '/' && path.startsWith(`${t.href}/`)) ? 'page' : undefined}
          >
            {t.label}
            {'count' in t && t.count ? (
              <span className="pc-count" aria-label={`${String(t.count)} waiting`}>
                {t.count > 99 ? '99+' : t.count}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/**
 * Spec 0037 Q15: how many things wait in the inbox, on its tab: read on every page change and every minute. A failed
 * read shows no count rather than a wrong one; the inbox page itself reports errors.
 */
function useInboxCount(path: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      void api<PlatformInbox>('GET', '/inbox')
        .then((r) => {
          if (live) setCount(r.count);
        })
        .catch(() => undefined);
    read();
    const timer = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path]);
  return count;
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
