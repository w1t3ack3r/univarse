'use client';

import { Archive, FileText, Grid, Home, More, OrgChart, Sliders, Users } from '@univarse/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { NavIcon, NavItem } from '@/lib/nav';

const ICONS: Record<NavIcon, typeof Home> = { home: Home, users: Users, structure: OrgChart, products: Grid, settings: Sliders, documents: FileText, export: Archive };

/** The phone's bar holds five: past that, four and "More" (spec 0038 added a sixth for IT Admins). */
export const THUMB_SLOTS = 5;

const isCurrent = (item: NavItem, path: string) => (item.href === '/workspace' ? path === '/workspace' : path.startsWith(item.href));

function Item({ item, current }: { item: NavItem; current: boolean }) {
  const Icon = item.icon ? ICONS[item.icon] : null;
  return (
    <li>
      <Link className="navlink" href={item.href} aria-current={current ? 'page' : undefined}>
        {Icon ? <Icon size={22} /> : null}
        <span>{item.label}</span>
      </Link>
    </li>
  );
}

/**
 * Current page marked with aria-current (lime pill: the one place lime marks "you are here"). The rail lists every
 * item. The phone's thumb bar shows at most five; with more, the first four and a "More" button whose sheet (the
 * browser's popover: Escape and a tap outside close it) holds the rest. When the current page is in the sheet, "More"
 * carries the lime.
 */
export function NavLinks({ items, variant = 'rail' }: { items: readonly NavItem[]; variant?: 'rail' | 'thumb' }) {
  const path = usePathname();
  const sheet = useRef<HTMLDivElement>(null);
  // A link in the sheet navigates in place (the layout stays): close the sheet with it.
  useEffect(() => {
    if (sheet.current?.matches(':popover-open')) sheet.current.hidePopover();
  }, [path]);

  if (variant === 'rail' || items.length <= THUMB_SLOTS) {
    return (
      <ul>
        {items.map((item) => (
          <Item key={item.href} item={item} current={isCurrent(item, path)} />
        ))}
      </ul>
    );
  }
  const shown = items.slice(0, THUMB_SLOTS - 1);
  const rest = items.slice(THUMB_SLOTS - 1);
  const inRest = rest.some((i) => isCurrent(i, path));
  return (
    <>
      <ul>
        {shown.map((item) => (
          <Item key={item.href} item={item} current={isCurrent(item, path)} />
        ))}
        <li>
          <button type="button" className="navlink navlink--more" popoverTarget="ws-more" data-current={inRest || undefined}>
            <More size={22} />
            <span>More</span>
          </button>
        </li>
      </ul>
      <div ref={sheet} id="ws-more" popover="auto" className="ws__more" aria-label="More pages">
        <ul>
          {rest.map((item) => (
            <Item key={item.href} item={item} current={isCurrent(item, path)} />
          ))}
        </ul>
      </div>
    </>
  );
}
