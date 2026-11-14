/**
 * Spec 0037 Q8 (J10, "suspended tenant login blocked"): a suspended institution's address says so, plainly, in its own
 * name: "temporarily unavailable", not "not found", with nothing to sign in to. The seed's `paused-uni` is suspended;
 * the console's suspend → sessions ended → resume is proved in the API's suspension suite, against the same chain.
 * The stack seeds no suspended institution: criterion 12 (the owner's check) covers it there.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, E2E, hostUrl, randomClientIp } from './fixtures';

const PAUSED = E2E.origin('paused-uni');
const DEMO = hostUrl('demo-uni');

test.skip(E2E.stack, 'the stack seeds no suspended institution');

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

async function seriousA11yViolations(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

const pausedPage = async (page: Page) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Temporarily unavailable' })).toBeVisible();
  await expect(page.getByText('Paused University')).toBeVisible();
  await expect(page.getByText('This institution is temporarily unavailable. Please contact your ICT unit.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/not found/i)).toHaveCount(0);
};

test('[Q8] the sign-in page of a suspended institution says it’s temporarily unavailable, and passes axe', async ({ page }) => {
  await page.goto(`${PAUSED}/login`);
  await pausedPage(page);
  expect(await seriousA11yViolations(page)).toEqual([]);
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/suspended-${test.info().project.name}.png`, fullPage: true });
});

test('[Q8] its workspace and its other sign-in pages lead to the same page, not an error', async ({ page }) => {
  await page.goto(`${PAUSED}/workspace`);
  await expect(page).toHaveURL(`${PAUSED}/login`);
  await pausedPage(page);
  await page.goto(`${PAUSED}/reset-password`);
  await pausedPage(page);
});

test('[Q8] another institution signs in as usual', async ({ page }) => {
  await page.goto(`${DEMO}/login`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Temporarily unavailable')).toHaveCount(0);
});
