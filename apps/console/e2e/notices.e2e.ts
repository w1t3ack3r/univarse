// Spec 0037 Q9, Q11, Q12: SUPPORT writes a notice to one institution, sees the banner exactly as it will show (markup
// as text), saves it, publishes it after a step-up, and withdraws it; the institution's page lists it. An OWNER puts
// the institution in the pilot ring. Desktop and phone, with axe. Set E2E_SHOTS to a folder to keep each screen.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { enrol, makeInstitution, makeMember, PASSWORD, randomClientIp, totp } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Console' });
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

const confirm = async (page: Page, secret: string) => {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
  await expect(dialog).toBeHidden();
};

const MARKUP = '<b>Bold?</b> No: this is text.';
let institution: { id: string; legalName: string; shortName: string };

test('SUPPORT writes, publishes and withdraws a notice to one institution', async ({ page }) => {
  institution = await makeInstitution();
  const { secret } = await signInNew(page, 'SUPPORT');
  await tabs(page).getByRole('link', { name: 'Notices' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notices' })).toBeVisible();
  await page.getByRole('link', { name: 'Write a notice' }).click();

  await test.step('the preview is the banner as it will show, markup as text', async () => {
    await page.getByLabel('Title').fill('New results screens');
    await page.getByLabel('Message').fill(MARKUP);
    const preview = page.getByRole('complementary', { name: 'As an institution sees it' });
    await expect(preview.getByText(MARKUP, { exact: true })).toBeVisible();
    await expect(preview.locator('b')).toHaveCount(0);
    await page.getByLabel('Add an institution').fill(institution.shortName);
    await page.getByRole('button', { name: `Add ${institution.shortName}` }).click();
    await expect(page.getByRole('list', { name: 'Chosen institutions' }).getByText(institution.shortName)).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'notice-write');
  });

  await test.step('saving keeps a draft; publishing asks for a step-up and fixes it', async () => {
    await page.getByRole('button', { name: 'Save the draft' }).click();
    await confirm(page, secret);
    await expect(page).toHaveURL(/\/notices\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Draft notice' })).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New results screens' })).toBeVisible();
    await expect(page.locator('.pc-section__head .pc-status')).toHaveText('Showing');
    const reached = page.getByRole('table');
    await expect(reached.getByRole('link', { name: institution.shortName })).toBeVisible();
    await expect(page.getByLabel('Title')).toHaveCount(0);
    await expectAccessible(page);
    await shot(page, 'notice-published');
  });

  await test.step('withdrawing takes it down everywhere', async () => {
    await page.getByRole('button', { name: 'Withdraw this notice' }).click();
    await expect(page.getByText('Withdrawn. Its banner has left every institution.')).toBeVisible();
    await expect(page.locator('.pc-section__head .pc-status')).toHaveText('Withdrawn');
    await expect(page.getByRole('button', { name: 'Withdraw this notice' })).toHaveCount(0);
  });

  await test.step('the institution lists the notice it got; SUPPORT can’t change its ring', async () => {
    await page.goto(`/institutions/${institution.id}`);
    const section = page.getByRole('region', { name: 'Releases and notices' });
    await expect(section.getByRole('link', { name: /New results screens/ })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Pilot' })).toHaveCount(0);
    await expect(section.getByText('General', { exact: true })).toBeVisible();
  });
});

test('an OWNER puts an institution in the pilot ring', async ({ page }) => {
  const { secret } = await signInNew(page, 'OWNER');
  await page.goto(`/institutions/${institution.id}`);
  const section = page.getByRole('region', { name: 'Releases and notices' });
  await section.getByRole('button', { name: 'Pilot' }).click();
  await confirm(page, secret);
  await expect(page.getByText(`${institution.shortName} is in the pilot ring.`)).toBeVisible();
  await expect(section.getByRole('button', { name: 'Pilot' })).toHaveAttribute('aria-pressed', 'true');
  await expectAccessible(page);
  await shot(page, 'institution-ring');
});
