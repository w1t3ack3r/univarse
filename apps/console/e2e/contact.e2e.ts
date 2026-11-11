// Spec 0032 PR A: a member changes their address and signs in with the new one, an owner corrects someone's, and the
// old address undoes a change: a real browser, the dev edge, the platform API and Mailpit.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { emailedCode, enrol, makeMember, PASSWORD, randomClientIp, totp, uniqueEmail } from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test.describe.configure({ mode: 'serial', timeout: 120_000 });

async function signInNew(page: Page, role: 'OWNER' | 'SUPPORT'): Promise<{ email: string; secret: string }> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  const { secret } = await enrol(page);
  return { email, secret };
}

const signOut = async (page: Page) => {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
};

/** The undo code from the newest mail to `to`. */
async function emailedUndo(to: string, since: Date): Promise<string> {
  const base = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  const deadline = Date.now() + 20_000;
  for (;;) {
    const list = (await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages: { ID: string; Created: string; Subject: string }[] };
    const fresh = list.messages.find((m) => m.Subject.includes('your address was changed') && new Date(m.Created).getTime() >= since.getTime() - 1000);
    if (fresh) {
      const msg = (await (await fetch(`${base}/api/v1/message/${fresh.ID}`)).json()) as { Text: string };
      const m = /undo code is ([A-Z2-7-]+)/.exec(msg.Text);
      if (m?.[1]) return m[1];
    }
    if (Date.now() > deadline) throw new Error('No undo code was emailed within 20 s');
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('a member changes their address, signs in with it, and the old address can undo it', async ({ page }) => {
  const m = await signInNew(page, 'SUPPORT');
  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Your account' }).click();
  await expect(page.getByRole('heading', { name: 'Your email address' })).toBeVisible();
  await expectAccessible(page);

  const to = uniqueEmail('moved');
  const asked = new Date();
  await page.getByLabel('New email address').fill(to);
  await page.getByRole('button', { name: 'Send a code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Code from your authenticator app').fill(totp(m.secret, 1));
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`We sent a code to ${to}.`)).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('Code from the email').fill(await emailedCode(to, asked));
  await page.getByRole('button', { name: 'Confirm this address' }).click();
  await expect(page.getByText('Your address is changed.')).toBeVisible();
  await expect(page.locator('.pc-head__email')).toHaveText(to);
  expect(page.url()).not.toContain('@');

  await signOut(page);
  await page.getByLabel('Email').fill(m.email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That email or password isn’t right.')).toBeVisible(); // the old address no longer signs in

  await page.getByLabel('Email').fill(to);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/sign-in\/verify$/);

  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Undo an address change' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Undo an address change' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Your old email address').fill(m.email);
  await page.getByLabel('Undo code').fill(await emailedUndo(m.email, asked));
  await page.getByRole('button', { name: 'Undo the change' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your address is back' })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Set a new password' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
});

test('an owner corrects an address, and only the person can finish it', async ({ browser, page }) => {
  const owner = await signInNew(page, 'OWNER');
  const context = await browser.newContext();
  const theirPage = await context.newPage();
  const m = await signInNew(theirPage, 'SUPPORT');
  await signOut(theirPage);

  await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Staff' }).click();
  const row = page.getByRole('listitem').filter({ hasText: m.email });
  await row.getByText('Manage').click();
  const to = uniqueEmail('corrected');
  const asked = new Date();
  await row.getByLabel(/^Correct .*’s email$/).fill(to);
  await row.getByLabel(/The old address is wrong/).check();
  await expectAccessible(page);
  await row.getByRole('button', { name: 'Correct the address' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Code from your authenticator app').fill(totp(owner.secret, 1));
  await expect(dialog).toBeHidden();
  await expect(page.getByText('A code went to the new address.')).toBeVisible();

  const code = await emailedCode(to, asked);
  await theirPage.goto('/sign-in');
  await theirPage.getByRole('link', { name: 'Confirm a new address' }).click();
  await expect(theirPage.getByRole('heading', { level: 1, name: 'Confirm a new address' })).toBeVisible();
  await expectAccessible(theirPage);
  await theirPage.getByLabel('Your new email address').fill(to);
  await theirPage.getByLabel('Code from the email').fill(code);
  await theirPage.getByLabel('Your password', { exact: true }).fill('Not-The-Password-1234');
  await theirPage.getByRole('button', { name: 'Confirm this address' }).click();
  await expect(theirPage.getByText('That didn’t work.')).toBeVisible();

  await theirPage.getByLabel('Your password', { exact: true }).fill(PASSWORD);
  await theirPage.getByRole('button', { name: 'Confirm this address' }).click();
  await expect(theirPage.getByRole('heading', { level: 1, name: 'Your address is changed' })).toBeVisible();
  await context.close();
});
