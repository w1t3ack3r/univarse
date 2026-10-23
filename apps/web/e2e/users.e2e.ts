/**
 * Spec 0021 (P7): the Users page, a page at a time, through the real edge → web → API → DB. Desktop and mobile.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, cleanup, clearReplayGuard, currentTotp, hostUrl, makeListFiller, makeUser, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test.afterAll(async () => {
  await cleanup();
});

async function signInWithMfa(page: Page): Promise<void> {
  // REGISTRAR holds identity.user.view and a privileged permission, so MFA is part of it.
  const u = await makeUser('demo-uni', { role: 'REGISTRAR', mfa: true });
  await clearReplayGuard('demo-uni', u);
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await page.getByLabel('6-digit code').fill(currentTotp(u));
  await expect(page).toHaveURL(`${DEMO}/workspace`);
}

const rows = (page: Page) => page.getByRole('table', { name: /Users in this institution/ }).locator('tbody tr');

test('[spec 0021][P7] the Users page moves to the next page and back; no username in the URL; accessible', async ({ page }) => {
  await makeListFiller('demo-uni', 55); // more than one page, whatever else the run created
  await signInWithMfa(page);
  await page.goto(`${DEMO}/workspace/users`);
  await expect(rows(page)).toHaveCount(50);
  const firstPage = await rows(page).locator('td:nth-child(2)').allTextContents();

  const pager = page.getByRole('navigation', { name: 'Pages of users' });
  await expect(pager.getByRole('link', { name: 'Back to the first page' })).toHaveCount(0);
  await pager.getByRole('link', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/\/workspace\/users\?cursor=[A-Za-z0-9_-]+$/);
  const url = decodeURIComponent(page.url());
  for (const username of firstPage) expect(url, 'a username in the URL').not.toContain(username);
  const secondPage = await rows(page).locator('td:nth-child(2)').allTextContents();
  expect(secondPage.length).toBeGreaterThan(0);
  expect(secondPage.filter((u) => firstPage.includes(u))).toEqual([]); // nothing repeated (order: users.int.spec.ts)
  expect(await seriousA11yViolations(page)).toEqual([]);

  await pager.getByRole('link', { name: 'Back to the first page' }).click();
  await expect(page).toHaveURL(`${DEMO}/workspace/users`);
  await expect(rows(page).locator('td:nth-child(2)')).toHaveText(firstPage);
});

test('[spec 0021][P5] a stale or edited page link says so, and leads back to the first page', async ({ page }) => {
  await signInWithMfa(page);
  await page.goto(`${DEMO}/workspace/users?cursor=bm90LWEtY3Vyc29y`);
  await expect(page.locator('.uv-notice[role="alert"]')).toContainText('This list has changed since you opened that page');
  await page.getByRole('link', { name: 'Back to the first page' }).click();
  await expect(page).toHaveURL(`${DEMO}/workspace/users`);
  await expect(rows(page).first()).toBeVisible();
});

async function seriousA11yViolations(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}
