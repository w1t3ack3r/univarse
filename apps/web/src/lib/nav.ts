// Workspace navigation (spec 0005 W6, docs/11 §1): each item declares its product and, optionally,
// the permission it needs. Items the user can't use are not rendered. The API stays the enforcement point.
import type { Permission, ProductKey } from '@univarse/contracts';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly product: ProductKey;
  readonly requires?: Permission;
}

/** Every workspace page. New pages are added here with their product and permission. */
export const NAV: readonly NavItem[] = [
  { href: '/workspace', label: 'Home', product: 'core' },
  { href: '/workspace/users', label: 'Users', product: 'core', requires: 'identity.user.view' },
];

/** The items to show: product active for the institution AND permission held by the user. */
export function buildNav(
  items: readonly NavItem[],
  permissions: readonly string[],
  activeProducts: readonly string[],
): NavItem[] {
  const perms = new Set(permissions);
  const active = new Set(activeProducts);
  return items.filter((i) => active.has(i.product) && (i.requires === undefined || perms.has(i.requires)));
}
