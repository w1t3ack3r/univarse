// Workspace navigation (spec 0005 W6, docs/11 §1): each item declares its product and, optionally,
// the permission it needs. Items the user can't use are not rendered. The API stays the enforcement point.
import type { Permission, ProductKey } from '@univarse/contracts';

export type NavIcon = 'home' | 'users' | 'products' | 'settings' | 'documents';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon?: NavIcon;
  readonly product: ProductKey;
  readonly requires?: Permission;
}

/** Every workspace page. New pages are added here with their product and permission. */
export const NAV: readonly NavItem[] = [
  { href: '/workspace', label: 'Home', icon: 'home', product: 'core' },
  { href: '/workspace/documents', label: 'Documents', icon: 'documents', product: 'core', requires: 'files.file.upload' },
  { href: '/workspace/users', label: 'Users', icon: 'users', product: 'core', requires: 'identity.user.view' },
  { href: '/workspace/products', label: 'Products', icon: 'products', product: 'core', requires: 'settings.product.manage' },
  { href: '/workspace/settings', label: 'Settings', icon: 'settings', product: 'core', requires: 'settings.tenant.view' },
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
