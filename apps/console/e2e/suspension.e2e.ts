// Spec 0037 Q6, Q7: an OWNER suspends a live institution with a reason, after a step-up; the page leads with the
// suspension while the worker ends its sessions, then offers Resume, which brings it back as it was. SUPPORT sees the
// suspension and no action. Desktop and phone, with axe. Set E2E_SHOTS to a folder to keep a screenshot of each screen.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { enrol, makeInstitution, makeMember, PASSWORD, randomClientIp, totp } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

const shot = async (page: Page, name: string) => {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png`, fullPage: true });
};

async function signInNew(page: Page, role: 'OWNER' | 'SUPPORT'): Promise<{ secret: string }> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  return enrol(page);
}

let institution: { id: string; slug: string; legalName: string; shortName: string };

test('an OWNER suspends an institution with a reason, and resumes it once its sessions are ended', async ({ page }) => {
  const t = await makeInstitution();
  institution = t;
  const { secret } = await signInNew(page, 'OWNER');
  await page.goto(`/institutions/${t.id}`);
  await expect(page.getByRole('heading', { level: 1, name: t.legalName })).toBeVisible();

  await test.step('the form asks why, from a fixed list, and says what happens', async () => {
    await page.getByText(`Suspend ${institution.shortName}`, { exact: true }).first().click();
    const form = page.locator('form').filter({ has: page.getByRole('group', { name: 'Why?' }) });
    await expect(form.getByRole('radio')).toHaveCount(5);
    await expect(form.getByText('Unpaid fees aren’t a reason')).toBeVisible();
    const submit = form.getByRole('button', { name: `Suspend ${institution.shortName}` });
    await expect(submit).toBeDisabled();
    await form.getByLabel('A security incident').check();
    await form.getByLabel('Note (optional)').fill('Credential stuffing seen from one network');
    await expectAccessible(page);
    await shot(page, 'suspend-form');
    await submit.click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
    await expect(dialog).toBeHidden();
  });

  await test.step('the suspension leads the page until the worker has ended every session', async () => {
    await expect(page.getByText(`${institution.shortName} is suspended.`)).toBeVisible();
    const section = page.getByRole('region', { name: 'Suspended' });
    await expect(section).toBeVisible();
    await expect(section.getByText('A security incident')).toBeVisible();
    await expect(section.getByText('Credential stuffing seen from one network')).toBeVisible();
    await expect(page.locator('.pc-section__head .pc-status').first()).toHaveText('Suspended');
    // The worker runs every half second here; the page looks again every few seconds.
    await expect(section.getByText(/sessions? ended/)).toBeVisible({ timeout: 30_000 });
    await expect(section.getByRole('button', { name: `Resume ${institution.shortName}` })).toBeEnabled();
    await expectAccessible(page);
    await shot(page, 'suspended');
  });

  await test.step('resume brings it back as it was (the step-up window still holds)', async () => {
    await page.getByRole('button', { name: `Resume ${institution.shortName}` }).click();
    await expect(page.getByText(`${institution.shortName} is back and active.`)).toBeVisible();
    await expect(page.locator('.pc-section__head .pc-status').first()).toHaveText('Active');
    await expect(page.getByRole('heading', { name: 'Earlier suspensions' })).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'resumed');
  });
});

test('SUPPORT sees an institution’s suspensions, and no way to suspend or resume', async ({ page }) => {
  await signInNew(page, 'SUPPORT');
  await page.goto(`/institutions/${institution.id}`);
  await expect(page.getByRole('heading', { level: 1, name: institution.legalName })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Earlier suspensions' })).toBeVisible();
  await expect(page.getByText(`Suspend ${institution.shortName}`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Resume/ })).toHaveCount(0);
  await expectAccessible(page);
});
