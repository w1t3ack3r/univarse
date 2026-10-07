/**
 * Spec 0005 PR B — activation, password reset, two-step setup and step-up through the real
 * edge → web → API → DB → worker → Mailpit chain (W11–W15). Closes spec 0001's browser gap (HTTP).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, cleanup, clearReplayGuardFor, emailedCode, hostUrl, makeUser, PASSWORD, randomClientIp, totpFromKey } from './fixtures';

const DEMO = hostUrl('demo-uni');
const NEW_PASSWORD = 'Kola nut on a Tuesday 4';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});
test.afterAll(async () => {
  await cleanup();
});

const notice = (page: Page) => page.locator('.uv-notice[role="alert"]');
async function seriousA11y(page: Page) {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}
async function signIn(page: Page, username: string, password = PASSWORD) {
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('[W11][W15] activation: emailed code → password → done → sign in', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT', pending: true });
  await page.goto(`${DEMO}/login`);
  await page.getByRole('link', { name: 'Activate your account' }).click();
  await expect(page).toHaveURL(`${DEMO}/activate`);
  await expect(page).toHaveTitle('Activate your account · UniVarse');
  expect(await seriousA11y(page)).toEqual([]);

  const since = new Date();
  await page.getByLabel('Matric or staff number').fill(u.username);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText(/Valid for 15 more minutes/)).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);

  await page.getByLabel('6-digit code').fill(await emailedCode(u.email, since));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Activate my account' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to Demo University, Lagos' })).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);

  await page.getByRole('link', { name: 'Sign in' }).click();
  await signIn(page, u.username, NEW_PASSWORD);
  await expect(page).toHaveURL(`${DEMO}/workspace`);
});

test('[W11] activation: a wrong code returns to the code step; a weak password gets plain feedback', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT', pending: true });
  await page.goto(`${DEMO}/activate`);
  const since = new Date();
  await page.getByLabel('Matric or staff number').fill(u.username);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  const code = await emailedCode(u.email, since);
  const wrong = code === '000000' ? '111111' : '000000';

  await page.getByLabel('6-digit code').fill(wrong);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Activate my account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText('That code didn’t work.')).toBeVisible();

  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByRole('button', { name: 'Activate my account' }).click();
  await expect(page.getByText('That password is too easy to guess.')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('aria-invalid', 'true');
});

test('[W12][W15] password reset: code → new password → signed out everywhere → new password works', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await page.goto(`${DEMO}/login`);
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page).toHaveURL(`${DEMO}/reset-password`);
  const since = new Date();
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await page.getByLabel('6-digit code').fill(await emailedCode(u.email, since));
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await expect(page.getByText(/signed you out on every device/)).toBeVisible();

  await signIn(page, u.username, PASSWORD);
  await expect(notice(page)).toContainText('not right');
  await signIn(page, u.username, NEW_PASSWORD);
  await expect(page).toHaveURL(`${DEMO}/workspace`);
});

test('[W13][W15] two-step setup: password → key → code → recovery codes (shown once, gated) → workspace', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'INSTITUTION_ADMIN' }); // privileged without MFA → enrolment-only
  await signIn(page, u.username);
  await expect(page).toHaveURL(`${DEMO}/mfa/setup`);
  await expect(page.getByRole('heading', { name: 'Turn on two-step sign-in' })).toBeVisible();
  await page.goto(`${DEMO}/workspace`);
  await expect(page).toHaveURL(`${DEMO}/mfa/setup`); // restricted session: nothing else reachable

  await page.getByLabel('Confirm your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' }).locator('svg')).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);
  await page.getByText('Can’t scan? Type this key instead').click();
  const key = (await page.getByLabel('Setup key').innerText()).trim();
  expect(key.replace(/\s+/g, '')).toMatch(/^[A-Z2-7]{16,}$/);

  await page.getByRole('button', { name: 'I’ve added it' }).click();
  await page.getByLabel('6-digit code').fill(totpFromKey(key));
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem')).toHaveCount(10);
  const go = page.getByRole('button', { name: 'Go to my workspace' });
  await expect(go).toBeDisabled(); // gated until the person says they saved them
  expect(await seriousA11y(page)).toEqual([]);
  await page.getByLabel(/I’ve saved these codes/).check();
  await go.click();
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  await expect(page.getByText('On. Signing in needs a code from your phone.')).toBeVisible();
});

test('[W14][W15] step-up: managing products asks "confirm it’s you", then the switch works', async ({ page }) => {
  // An IT Admin who has just set up two-step sign-in (via the real flow).
  const u = await makeUser('demo-uni', { role: 'INSTITUTION_ADMIN' });
  await signIn(page, u.username);
  await page.getByLabel('Confirm your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Can’t scan? Type this key instead').click();
  const key = (await page.getByLabel('Setup key').innerText()).trim();
  await page.getByRole('button', { name: 'I’ve added it' }).click();
  await page.getByLabel('6-digit code').fill(totpFromKey(key));
  await page.getByLabel(/I’ve saved these codes/).check();
  await page.getByRole('button', { name: 'Go to my workspace' }).click();
  await expect(page).toHaveURL(`${DEMO}/workspace`);

  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Products' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you to manage products' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm it’s me' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);
  await clearReplayGuardFor('demo-uni', u.username); // the setup step used this 30 s window
  await dialog.getByLabel('Your password').fill(PASSWORD);
  await dialog.getByLabel('Code from your authenticator app').fill(totpFromKey(key));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();

  const bursary = page.getByRole('switch', { name: 'Bursary' });
  await expect(bursary).toHaveAttribute('aria-checked', 'false');
  await bursary.click();
  await expect(bursary).toHaveAttribute('aria-checked', 'true');
  await bursary.click(); // restore the seeded state
  await expect(bursary).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Not in your plan. Contact UniVarse to add it.').first()).toBeVisible();
});
