// Spec 0028 PR B: the console's journeys through a real browser, the dev edge, the platform API and its database:
// an OWNER's first sign-in, an invitation taken up, and the second factor (acceptance criterion 3: a session without a
// confirmed factor reaches only enrolment; a password alone gets no session). One run of the three per project, in
// order: each takes up where the last left off.
import { expect, test } from '@playwright/test';
import { expectAccessible } from './a11y';
import { apiStatus, emailedCode, enrol, makeMember, PASSWORD, randomClientIp, totp, uniqueEmail } from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test.describe.configure({ mode: 'serial', timeout: 90_000 });

let owner: { email: string; secret: string; codes: string[] };
let invitee: { email: string; invitedAt: Date };

test('an OWNER’s first sign-in: enrolment only, until the authenticator and the codes; then staff, with a step-up', async ({ page }) => {
  const { email } = await makeMember('OWNER');
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to the console' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);

  // Before the factor is confirmed: who you are, yes; anything else, no; and the console sends you back to setup.
  expect(await apiStatus(page, '/me')).toBe(200);
  expect(await apiStatus(page, '/staff')).toBe(403);
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);

  const { secret, codes } = await enrol(page);
  owner = { email, secret, codes };
  expect(await apiStatus(page, '/staff')).toBe(200);

  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Staff' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  await expect(page.getByText('(you)')).toBeVisible();
  await expectAccessible(page);

  const invite = page.getByRole('group').filter({ has: page.getByText('Invite a member') });
  await invite.getByText('Invite a member').click();
  const to = uniqueEmail('support');
  await invite.getByLabel('Their name').fill('Tunde E2E');
  await invite.getByLabel('Their work email').fill(to);
  await invite.getByLabel('Role').selectOption('SUPPORT');
  const invitedAt = new Date();
  await invite.getByRole('button', { name: 'Send the invitation' }).click();

  // The change asks for the authenticator first (step-up), then happens.
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1)); // the step after enrolment's; six digits submit by themselves
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Invitation sent to ${to}.`)).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: to })).toContainText('Not activated yet');
  invitee = { email: to, invitedAt };
});

test('an invited member activates with the emailed code, sets up, and has no Staff page', async ({ page }) => {
  const code = await emailedCode(invitee.email, invitee.invitedAt);
  await page.goto('/activate');
  await expect(page.getByRole('heading', { level: 1, name: 'Activate your account' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Email').fill(invitee.email);
  await page.getByLabel('Code from your invitation').fill(code);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await enrol(page);

  const tabs = page.getByRole('navigation', { name: 'Console' });
  await expect(tabs.getByRole('link', { name: 'Your account' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Staff' })).toHaveCount(0);
  // Out of scope reads as absent, in the API and on the page.
  expect(await apiStatus(page, '/staff')).toBe(404);
  await page.goto('/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'There’s nothing at this address' })).toBeVisible();
});

test('a password alone gets no session; a recovery code finishes the sign-in, and signing out ends it', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Enter your authenticator code' })).toBeVisible();
  await expectAccessible(page);

  // Between the password and the second factor there is no session at all.
  expect(await apiStatus(page, '/me')).toBe(401);
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.goto('/sign-in/verify');
  await page.getByRole('button', { name: 'I don’t have my phone: use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(owner.codes[0]!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Your account' }).click();
  await expect(page.getByRole('heading', { name: 'Where you’re signed in' })).toBeVisible();
  await expect(page.getByText('This browser')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await apiStatus(page, '/me')).toBe(401);
});
