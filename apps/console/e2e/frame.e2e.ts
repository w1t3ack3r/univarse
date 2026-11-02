// Spec 0027 P6, with S2's sign-in (spec 0028): the console's frame through a real browser: the platform bar and its
// environment, accessible, under a nonce CSP, and its own 404. These pages need no platform API, so the image job runs
// this file alone against the built image.
import { expect, test } from '@playwright/test';
import { expectAccessible } from './a11y';

test('the frame: the platform bar, LOCAL, and the sign-in page', async ({ page }) => {
  const res = await page.goto('/sign-in');
  expect(res?.status()).toBe(200);
  const bar = page.getByRole('banner');
  await expect(bar.getByRole('link', { name: 'UniVarse platform console, home' })).toBeVisible();
  await expect(bar.getByText('LOCAL', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to the console' })).toBeVisible();
  // Signed out, there is nothing to navigate to.
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('the home page is server-rendered with its title (what the image and stack smokes look for)', async ({ page }) => {
  // The browser's own response: Node's resolver doesn't know *.localhost on every system, Chromium does.
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  expect(await res?.text()).toMatch(/<title>[^<]*Platform console/);
});

test('the frame is accessible (axe, WCAG 2.2 AA) and fits the width without scrolling sideways', async ({ page }) => {
  await page.goto('/sign-in');
  await expectAccessible(page);
});

test('the CSP carries a nonce, every script carries it, and the console is never indexed', async ({ page }) => {
  const res = await page.goto('/sign-in');
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
  const res = await page.goto('/nowhere');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'There’s nothing at this address' })).toBeVisible();
});
