import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { LogoutButton } from '@/components/LogoutButton';
import { buildNav, NAV } from '@/lib/nav';
import { serverApi } from '@/lib/server-api';
import { requireSession } from '@/lib/session';
import { tenantProfile } from '@/lib/tenant';

/** Spec 0005 W6: institution, user, logout, and navigation from permissions + active products. */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const me = await requireSession();
  const [{ profile }, products] = await Promise.all([tenantProfile(), serverApi<{ data: string[] }>('/api/v1/products')]);
  const nav = buildNav(NAV, me.permissions, products.body?.data ?? ['core']);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr] md:grid-rows-[auto_1fr]">
      <header className="uv-on-deep flex items-center justify-between gap-3 px-4 py-3 md:col-span-2">
        <div className="flex min-w-0 items-center gap-3">
          <Logo tone="lime" height={26} />
          <span className="truncate text-sm" data-testid="institution">
            {profile?.shortName}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm sm:inline" data-testid="user-name">
            {me.displayName}
          </span>
          <LogoutButton />
        </div>
      </header>
      <nav aria-label="Workspace" className="border-b border-border bg-surface md:border-b-0 md:border-r">
        <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col">
          {nav.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="block min-h-11 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-offwhite"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className="p-4 md:p-8">
        {children}
      </main>
    </div>
  );
}
