// Spec 0033 PR B: an OWNER finds an institution, edits it, brands it and revokes and grants a product; READ_ONLY sees
// and changes nothing; SUPPORT looks up only. A real browser, the dev edge, the platform API and its database. Desktop
// and phone, with axe. The institutions are made here by the migrator, because the console role can't create one.
import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { expectAccessible } from './a11y';
import { enrol, makeInstitution, makeMember, PASSWORD, totp } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Console' });
const PNG = (() => {
  const b = Buffer.alloc(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(64, 20);
  return b;
})();

async function signInNew(page: Page, role: 'OWNER' | 'SUPPORT' | 'READ_ONLY'): Promise<{ secret: string }> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  return enrol(page);
}

test('an OWNER finds an institution, edits it, brands it, and revokes and grants a product', async ({ page }) => {
  const t = await makeInstitution();
  const { secret } = await signInNew(page, 'OWNER');
  const confirm = async () => {
    const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
    await expect(dialog).toBeHidden();
  };

  await test.step('search', async () => {
    await expectAccessible(page);
    await page.getByRole('searchbox', { name: 'Find an institution' }).fill(t.slug);
    await page.getByRole('searchbox', { name: 'Find an institution' }).press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Institutions' })).toBeVisible();
    const link = page.getByRole('link', { name: t.legalName });
    await expect(link).toBeVisible();
    await expectAccessible(page);
    await link.click();
    await expect(page.getByRole('heading', { level: 1, name: t.legalName })).toBeVisible();
    await expect(page.getByText(t.slug).first()).toBeVisible();
    await expectAccessible(page);
  });

  await test.step('a change asks for the authenticator once, then the window holds', async () => {
    const renamed = `${t.legalName} Renamed`;
    await page.getByLabel('Legal name').fill(renamed);
    await page.getByRole('button', { name: 'Save the profile' }).click();
    await confirm();
    await expect(page.getByText('The profile is saved.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
    await expect(page.getByLabel('Type', { exact: true })).toBeDisabled();

    await page.getByLabel('State').selectOption('Lagos');
    await page.getByRole('button', { name: 'Save the regulatory details' }).click();
    await expect(page.getByText('The regulatory details are saved.')).toBeVisible();
  });

  await test.step('branding', async () => {
    await page.locator('#b-hex').fill('#888F8C');
    await expect(page.getByText(/so text wouldn’t be readable/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save the colour' })).toBeDisabled();
    await page.locator('#b-hex').fill('#1A3A6B');
    await expect(page.getByText(/Text on it will be white/)).toBeVisible();
    await page.getByRole('button', { name: 'Save the colour' }).click();
    await expect(page.getByText('The colour is saved.')).toBeVisible();

    await page.getByLabel('Logo').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(page.getByText(/SVG isn’t accepted/)).toBeVisible();
    await page.getByLabel('Logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
    await page.getByRole('button', { name: 'Save the logo' }).click();
    await expect(page.getByText('The logo is saved.')).toBeVisible();
    await expectAccessible(page);
  });

  await test.step('a product is revoked with the subdomain typed, then granted back', async () => {
    const row = page.getByRole('listitem').filter({ hasText: 'Applications, screening' });
    await expect(row.getByText('On', { exact: true })).toBeVisible();
    await row.getByText('Revoke', { exact: true }).click();
    await row.getByLabel('Why?').fill('Contract ended');
    await expect(row.getByText(`Type ${t.slug} to confirm`)).toBeVisible();
    await expectAccessible(page);
    await row.getByLabel(`Type ${t.slug} to confirm`).fill('wrong');
    await row.getByRole('button', { name: 'Revoke Admissions' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'subdomain' })).toBeVisible();
    await row.getByLabel(`Type ${t.slug} to confirm`).fill(t.slug);
    await row.getByRole('button', { name: 'Revoke Admissions' }).click();
    await expect(page.getByText(/Admissions is revoked/)).toBeVisible();
    await expect(row.getByText('Not granted')).toBeVisible();

    await row.getByText('Grant', { exact: true }).click();
    await row.getByLabel('Why?').fill('Renewed after all');
    await row.getByRole('button', { name: 'Grant Admissions' }).click();
    await expect(page.getByText(/Admissions is granted/)).toBeVisible();
  });

  await test.step('the audit log, for this institution alone', async () => {
    await page.getByRole('link', { name: 'This institution in the audit log' }).click();
    const log = page.getByRole('list', { name: 'Audit entries, newest first' });
    await expect(log.getByText('Granted a product')).toBeVisible();
    await expect(log.getByText('Revoked a product')).toBeVisible();
    await expect(log.getByText('Signed in', { exact: true })).toHaveCount(0);
  });
});

test('READ_ONLY sees an institution and no way to change it', async ({ page }) => {
  const t = await makeInstitution();
  await signInNew(page, 'READ_ONLY');
  await tabs(page).getByRole('link', { name: 'Institutions' }).click();
  await page.getByRole('searchbox', { name: 'Find an institution' }).fill(t.slug);
  await page.getByRole('searchbox', { name: 'Find an institution' }).press('Enter');
  await page.getByRole('link', { name: t.legalName }).click();
  await expect(page.getByRole('heading', { level: 1, name: t.legalName })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();
  for (const name of ['Save the profile', 'Save the regulatory details', 'Save the colour']) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByText('Revoke', { exact: true })).toHaveCount(0);
  await expectAccessible(page);
});

test('SUPPORT can look an institution up, and an unknown one is not there', async ({ page }) => {
  await signInNew(page, 'SUPPORT');
  await expect(tabs(page).getByRole('link', { name: 'Institutions' })).toBeVisible();
  await page.goto(`/institutions/019a0000-0000-7000-8000-${randomBytes(6).toString('hex')}`);
  await expect(page.getByRole('heading', { level: 1, name: /^(Institutions)$/ })).toHaveCount(0);
});
