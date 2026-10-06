'use client';

import { FileText, Grid, Home, Sliders, Users } from '@univarse/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { NavIcon, NavItem } from '@/lib/nav';

const ICONS: Record<NavIcon, typeof Home> = { home: Home, users: Users, products: Grid, settings: Sliders, documents: FileText };

/** Current page marked with aria-current (lime pill: the one place lime marks "you are here"). */
export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const path = usePathname();
  return (
    <ul>
      {items.map((item) => {
        const Icon = item.icon ? ICONS[item.icon] : null;
        const current = item.href === '/workspace' ? path === '/workspace' : path.startsWith(item.href);
        return (
          <li key={item.href}>
            <Link className="navlink" href={item.href} aria-current={current ? 'page' : undefined}>
              {Icon ? <Icon size={22} /> : null}
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
