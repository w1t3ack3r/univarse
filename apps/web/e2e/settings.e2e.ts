/**
 * Spec 0007 ST13 — the course registration settings page, through edge → web → API → DB.
 * The admin switches Academics on (the key belongs to it), then the Registrar edits, resets and
 * meets a concurrent change. Runs on desktop and mobile.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { animationsSettled, cleanup, clearReplayGuardFor, currentTotp, hostUrl, makeUser, PASSWORD, randomClientIp, setProductEnabled } from './fixtures';

const DEMO = hostUrl('demo-uni');

test.afterAll(async () => {
  await setProductEnabled('demo-uni', 'academics', false); // seeded state
  await cleanup();
});

async function seriousA11y(page: Page) {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

type User = Awaited<ReturnType<typeof makeUser>>;

/** A fresh browser context, signed in with password + authenticator code. */
async function signedIn(browser: Browser, role: string, viewport: { width: number; height: number } | null): Promise<{ page: Page; u: User }> {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), extraHTTPHeaders: { 'x-forwarded-for': randomClientIp() } });
  const page = await context.newPage();
  const u = await makeUser('demo-uni', { role, mfa: true });
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await page.getByLabel('6-digit code').fill(currentTotp(u));
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  return { page, u };
}

/** Answers the step-up dialog. */
async function confirmItsMe(page: Page, u: User) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await clearReplayGuardFor('demo-uni', u.username); // sign-in used this 30 s window
  await dialog.getByLabel('Your password').fill(PASSWORD);
  await dialog.getByLabel('Code from your authenticator app').fill(currentTotp(u));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

test('[ST13] Registrar edits course registration limits; admin sees them read-only; conflicts and reset', async ({ browser, viewport }, info) => {
  test.slow(); // three sessions, two step-ups
  const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

  // Admin switches Academics on: the registration settings belong to it.
  const admin = await signedIn(browser, 'INSTITUTION_ADMIN', viewport);
  await nav(admin.page).getByRole('link', { name: 'Settings' }).click();
  await expect(admin.page.getByText('Course registration settings appear here once Academics is switched on')).toBeVisible();
  await nav(admin.page).getByRole('link', { name: 'Products' }).click();
  await admin.page.getByRole('button', { name: 'Confirm it’s me' }).click();
  await confirmItsMe(admin.page, admin.u);
  const academics = admin.page.getByRole('switch', { name: 'Academics' });
  if ((await academics.getAttribute('aria-checked')) === 'false') await academics.click();
  await expect(academics).toHaveAttribute('aria-checked', 'true');

  // Registrar: reads, edits with plain validation, saves after confirming it's them.
  const reg = await signedIn(browser, 'REGISTRAR', viewport);
  await nav(reg.page).getByRole('link', { name: 'Settings' }).click();
  await expect(reg.page).toHaveTitle('Settings · UniVarse');
  const min = reg.page.getByLabel('Minimum units');
  const max = reg.page.getByLabel('Maximum units');
  const save = reg.page.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled(); // nothing changed yet
  expect(await seriousA11y(reg.page)).toEqual([]);

  await min.fill('30');
  await max.fill('20');
  await save.click();
  await expect(reg.page.getByText('The maximum must be at least the minimum.')).toBeVisible();
  await expect(max).toHaveAttribute('aria-invalid', 'true');
  await max.fill('abc');
  await expect(reg.page.getByText('Enter a whole number.')).toBeVisible();
  expect(await seriousA11y(reg.page)).toEqual([]);

  await min.fill('16');
  await max.fill('26');
  await save.click();
  await confirmItsMe(reg.page, reg.u);
  await expect(reg.page.getByText('Saved: 16 to 26 units per semester.')).toBeVisible();
  await expect(reg.page.getByText('Custom', { exact: true })).toBeVisible();
  await expect(reg.page.getByText(new RegExp(`Set by ${reg.u.displayName} on `))).toBeVisible();
  await reg.page.screenshot({ path: info.outputPath('settings-registrar.png'), fullPage: true });

  // Admin oversight: same values, who changed them, but no form.
  await admin.page.goto(`${DEMO}/workspace/settings`);
  await expect(admin.page.getByText('16–26')).toBeVisible();
  await expect(admin.page.getByText(new RegExp(`Set by ${reg.u.displayName} on `))).toBeVisible();
  await expect(admin.page.getByLabel('Minimum units')).toHaveCount(0);
  await expect(admin.page.getByText('Only staff who manage course registration settings can change these.')).toBeVisible();
  await admin.page.screenshot({ path: info.outputPath('settings-admin-readonly.png'), fullPage: true });

  // A second Registrar tab saves first; this one gets the latest values, not a silent overwrite.
  const other = await reg.page.context().newPage();
  await other.goto(`${DEMO}/workspace/settings`);
  await other.getByLabel('Maximum units').fill('28');
  await other.getByRole('button', { name: 'Save changes' }).click();
  await expect(other.getByText('Saved: 16 to 28 units per semester.')).toBeVisible();
  await max.fill('27');
  await save.click();
  await expect(reg.page.getByText('Someone else changed this while you were editing. Here are the latest values.')).toBeVisible();
  await expect(max).toHaveValue('28');

  // Reset, confirmed inline.
  await reg.page.getByRole('button', { name: 'Reset to default' }).click();
  await reg.page.getByRole('button', { name: 'Yes, reset' }).click();
  await expect(reg.page.getByText('Back to the default: 15 to 24 units per semester.')).toBeVisible();
  await expect(reg.page.getByText('Default', { exact: true })).toBeVisible();
  expect(await seriousA11y(reg.page)).toEqual([]);
  await reg.page.screenshot({ path: info.outputPath('settings-after-reset.png'), fullPage: true });

  // Restore the seeded state through the UI: that also clears the API's product cache, which a
  // direct DB change would leave stale for up to 30 s (the next project's run would see Academics on).
  await admin.page.goto(`${DEMO}/workspace/products`);
  const academicsAgain = admin.page.getByRole('switch', { name: 'Academics' });
  await academicsAgain.click();
  await expect(academicsAgain).toHaveAttribute('aria-checked', 'false');

  await admin.page.context().close();
  await reg.page.context().close();
});
