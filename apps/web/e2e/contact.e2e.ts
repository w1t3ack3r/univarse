/**
 * Spec 0032 PR B: a user changes their address, the old address can undo it, and an administrator corrects someone's,
 * through the real edge → web → API → DB → Mailpit. Desktop and mobile, with axe.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { animationsSettled, cleanup, clearReplayGuard, currentTotp, emailedCode, hostUrl, makeUser, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});
test.afterAll(async () => {
  await cleanup();
});

const address = (tag: string) => `${tag}-${randomBytes(4).toString('hex')}@test.local`;

async function axe(page: Page): Promise<void> {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations).toEqual([]);
}

async function signIn(page: Page, username: string, password = PASSWORD): Promise<void> {
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The undo code from the mail to the old address. */
async function emailedUndo(to: string, since: Date): Promise<string> {
  const base = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await res.json()) as { messages: { ID: string; Created: string; Subject: string }[] };
    const fresh = list.messages.find((m) => m.Subject.includes('your address was changed') && new Date(m.Created).getTime() >= since.getTime() - 1000);
    if (fresh) {
      const msg = (await (await fetch(`${base}/api/v1/message/${fresh.ID}`)).json()) as { Text: string };
      const m = /undo code is ([A-Z2-7-]+)/.exec(msg.Text);
      if (m?.[1]) return m[1];
    }
    if (Date.now() > deadline) throw new Error(`No undo code emailed to ${to} within 20 s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

test('a user changes their address, and the old address can undo it', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await signIn(page, u.username);
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  await page.getByRole('link', { name: /^Your account/ }).click();
  await expect(page.getByRole('heading', { name: 'Your email address' })).toBeVisible();
  await expect(page.getByText(u.email)).toBeVisible();
  await axe(page);

  const to = address('moved');
  const asked = new Date();
  await page.getByLabel('New email address').fill(to);
  await page.getByRole('button', { name: 'Send a code' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Your password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(`We sent a code to ${to}.`)).toBeVisible();
  await axe(page);

  await page.getByLabel('Code from the email').fill(await emailedCode(to, asked));
  await page.getByRole('button', { name: 'Confirm this address' }).click();
  await expect(page.getByText('Your address is changed.')).toBeVisible();
  await expect(page.getByText(to, { exact: true })).toBeVisible();
  expect(page.url()).not.toContain('@');

  await page.context().clearCookies();
  await page.goto(`${DEMO}/login`);
  await page.getByRole('link', { name: 'Undo an address change' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Undo an address change' })).toBeVisible();
  await axe(page);
  await page.getByLabel('Matric or staff number').fill(u.username);
  await page.getByLabel('Undo code').fill(await emailedUndo(u.email, asked));
  await page.getByRole('button', { name: 'Undo the change' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your address is back' })).toBeVisible();
  await axe(page);

  await signIn(page, u.username); // the password may be an intruder's now
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(`${DEMO}/login`);
});

test('an administrator corrects an address, and only the person can finish it', async ({ browser, page }) => {
  const admin = await makeUser('demo-uni', { role: 'INSTITUTION_ADMIN', mfa: true });
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await clearReplayGuard('demo-uni', admin);
  await signIn(page, admin.username);
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await page.getByLabel('6-digit code').fill(currentTotp(admin));
  await expect(page).toHaveURL(`${DEMO}/workspace`);

  await page.goto(`${DEMO}/workspace/users`);
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  // The list is paged by username: this user may be on any page, so go to it through the API's own order.
  const row = page.getByRole('row').filter({ hasText: u.username });
  for (let next = page.getByRole('link', { name: 'Next page' }); (await row.count()) === 0 && (await next.count()) > 0; next = page.getByRole('link', { name: 'Next page' })) await next.click();
  await row.getByText('Correct address').click();
  const to = address('corrected');
  const asked = new Date();
  await row.getByLabel(/correct email$/).fill(to);
  await row.getByLabel(/The old address is wrong/).check();
  await axe(page);
  await row.getByRole('button', { name: 'Correct the address' }).click();
  const dialog = page.getByRole('dialog');
  await clearReplayGuard('demo-uni', admin);
  await dialog.getByLabel('Your password').fill(PASSWORD);
  await dialog.getByLabel('Code from your authenticator app').fill(currentTotp(admin));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(row.getByText('A code went to the new address.')).toBeVisible();

  const code = await emailedCode(to, asked);
  const context = await browser.newContext();
  const theirs = await context.newPage();
  await theirs.goto(`${DEMO}/login`);
  await theirs.getByRole('link', { name: 'Confirm a new address' }).click();
  await expect(theirs.getByRole('heading', { level: 1, name: 'Confirm a new address' })).toBeVisible();
  await axe(theirs);
  await theirs.getByLabel('Matric or staff number').fill(u.username);
  await theirs.getByLabel('Code from the email').fill(code);
  await theirs.getByLabel('Your password', { exact: true }).fill('Not-The-Password-1234');
  await theirs.getByRole('button', { name: 'Confirm this address' }).click();
  await expect(theirs.getByText('That didn’t work.')).toBeVisible();

  await theirs.getByLabel('Your password', { exact: true }).fill(PASSWORD);
  await theirs.getByRole('button', { name: 'Confirm this address' }).click();
  await expect(theirs.getByRole('heading', { level: 1, name: 'Your address is changed' })).toBeVisible();
  await context.close();
});
