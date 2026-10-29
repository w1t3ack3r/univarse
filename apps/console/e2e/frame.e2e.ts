// Spec 0027 P6: the console's frame through a real browser: the platform bar and its environment, one honest notice,
// accessible, under a nonce CSP, and its own 404.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('the frame: the platform bar, LOCAL, and the notice that sign-in comes next', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  const bar = page.getByRole('banner');
  await expect(bar.getByRole('link', { name: 'UniVarse platform console, home' })).toBeVisible();
  await expect(bar.getByText('LOCAL', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Sign-in isn’t available yet.');
  // No navigation, no sections, no forms: S1 has nothing to offer but the frame.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.locator('form')).toHaveCount(0);
});

test('the frame is accessible (axe, WCAG 2.2 AA) and fits the width without scrolling sideways', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(results.violations).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('the CSP carries a nonce, every script carries it, and the console is never indexed', async ({ page }) => {
  const res = await page.goto('/');
  const policy = res?.headers()['content-security-policy'] ?? '';
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("frame-ancestors 'none'");
  expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const scripts = await page.locator('script').evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
  expect(scripts.length).toBeGreaterThan(0);
  for (const n of scripts) expect(n).toBe(nonce);
});

test('an unknown address gets the console\'s own 404, inside the frame', async ({ page }) => {
  const res = await page.goto('/staff');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'There’s nothing at this address' })).toBeVisible();
});
