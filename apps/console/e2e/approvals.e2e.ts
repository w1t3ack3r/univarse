// Spec 0037 PR A: an OWNER asks for a member to be made an owner; a SUPER_ADMIN, in a browser of their own, finds it
// in the inbox and approves exactly what was asked, after a step-up; the OWNER sees it done. Desktop and phone, with
// axe. Set E2E_SHOTS to a folder to keep a screenshot of each screen.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { enrol, makeMember, PASSWORD, randomClientIp, totp } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Console' });
const shot = async (page: Page, name: string) => {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png`, fullPage: true });
};

async function signInNew(page: Page, role: 'OWNER' | 'SUPER_ADMIN' | 'SUPPORT'): Promise<{ secret: string }> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  return enrol(page);
}

const confirm = async (page: Page, secret: string) => {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
  await expect(dialog).toBeHidden();
};

test('making an owner takes two people: one asks, another approves exactly that', async ({ browser, page, context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
  const target = await makeMember('SUPPORT');

  // The second person, in a browser of their own, set up before anyone asks (a request needs someone to approve it).
  const use = test.info().project.use;
  const other = await browser.newContext({
    ...(use.baseURL ? { baseURL: use.baseURL } : {}),
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.isMobile !== undefined ? { isMobile: use.isMobile } : {}),
    ...(use.hasTouch !== undefined ? { hasTouch: use.hasTouch } : {}),
    extraHTTPHeaders: { 'x-forwarded-for': randomClientIp() },
  });
  const second = await other.newPage();
  const { secret: secondSecret } = await signInNew(second, 'SUPER_ADMIN');

  const { secret } = await signInNew(page, 'OWNER');
  let approvalUrl = '';

  await test.step('an OWNER can’t make an owner directly: the form becomes a request', async () => {
    await tabs(page).getByRole('link', { name: 'Staff' }).click();
    const row = page.getByRole('listitem').filter({ hasText: target.email });
    await row.getByText('Manage').click();
    await row.getByLabel('Role').selectOption('OWNER');
    await expect(row.getByText(/This needs a second person/)).toBeVisible();
    await row.getByLabel(`Why should ${target.displayName} be an owner?`).fill('They now run the platform with me.');
    await expectAccessible(page);
    await shot(page, 'staff-request');
    await row.getByRole('button', { name: 'Ask for an approval' }).click();
    await confirm(page, secret);
    await expect(page.getByText(`Your request to make ${target.displayName} an owner waits for a second person`)).toBeVisible();
    await expect(row.locator('.pc-role')).toHaveText('Support');
  });

  await test.step('the request shows exactly what will run, and that it waits', async () => {
    await tabs(page).getByRole('link', { name: 'Approvals' }).click();
    await page.getByRole('group', { name: 'Your requests' }).getByRole('link', { name: new RegExp(`Make ${target.displayName} an owner`) }).click();
    await expect(page.getByRole('heading', { level: 1, name: `Make ${target.displayName} an owner` })).toBeVisible();
    await expect(page.getByText('Waiting for a second person')).toBeVisible();
    await expect(page.getByText('They now run the platform with me.')).toBeVisible();
    await expect(page.getByText('staff.make_owner')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel the request' })).toBeVisible();
    approvalUrl = page.url();
    await expectAccessible(page);
    await shot(page, 'approval-waiting');
  });

  await test.step('the second person finds it in the inbox and approves it, after a step-up', async () => {
    await second.goto('/');
    await expect(tabs(second).getByRole('link', { name: /Inbox/ }).locator('.pc-count')).toBeVisible();
    await tabs(second).getByRole('link', { name: /Inbox/ }).click();
    await expect(second.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    await expect(second.getByRole('link', { name: /Make an owner: your decision/ }).first()).toBeVisible();
    await expectAccessible(second);
    await shot(second, 'inbox');

    await second.goto(approvalUrl);
    await expect(second.getByText('You’re the second person.')).toBeVisible();
    await expectAccessible(second);
    await shot(second, 'approval-decide');
    await second.getByRole('button', { name: `Approve: make ${target.displayName} an owner` }).click();
    await confirm(second, secondSecret);
    await expect(second.getByText('Approved and done').first()).toBeVisible();
    await expectAccessible(second);
    await shot(second, 'approval-done');
  });

  await test.step('the OWNER sees it done, and the member is an owner', async () => {
    await page.reload();
    await expect(page.getByText('Approved and done').first()).toBeVisible();
    await tabs(page).getByRole('link', { name: 'Staff' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: target.email }).locator('.pc-role')).toHaveText('Owner');
  });

  await other.close();
});

test('a member who can neither ask nor decide finds nothing to act on, and no Approvals tab', async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
  await signInNew(page, 'SUPPORT');
  await expect(tabs(page).getByRole('link', { name: 'Approvals' })).toHaveCount(0);
  await tabs(page).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'inbox-empty');
});
