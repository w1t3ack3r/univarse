import { describe, expect, it } from 'vitest';
import { buildNav, NAV, type NavItem } from './nav';

const items: NavItem[] = [
  { href: '/workspace', label: 'Home', product: 'core' },
  { href: '/workspace/users', label: 'Users', product: 'core', requires: 'identity.user.view' },
  { href: '/workspace/bursary', label: 'Bursary', product: 'bursary' },
  { href: '/workspace/admissions/review', label: 'Review', product: 'admissions', requires: 'identity.user.manage' },
];
const hrefs = (n: NavItem[]) => n.map((i) => i.href);

describe('[W6] navigation from permissions and active products', () => {
  it('shows core items without a permission to everyone', () => {
    expect(hrefs(buildNav(items, [], ['core']))).toEqual(['/workspace']);
  });

  it('shows a permission-gated item only to holders of that permission', () => {
    expect(hrefs(buildNav(items, ['identity.user.view'], ['core']))).toEqual(['/workspace', '/workspace/users']);
  });

  it('hides items of inactive products, even from users with the permission', () => {
    expect(hrefs(buildNav(items, ['identity.user.manage'], ['core']))).toEqual(['/workspace']);
    expect(hrefs(buildNav(items, ['identity.user.manage'], ['core', 'admissions']))).toContain('/workspace/admissions/review');
  });

  it('needs both: active product AND permission', () => {
    expect(hrefs(buildNav(items, [], ['core', 'bursary', 'admissions']))).toEqual(['/workspace', '/workspace/bursary']);
  });

  it('every real nav item points into the workspace', () => {
    for (const i of NAV) expect(i.href.startsWith('/workspace')).toBe(true);
  });
});
