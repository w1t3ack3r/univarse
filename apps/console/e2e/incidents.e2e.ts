// Spec 0037 Q13–Q15: SUPPORT opens an incident at one institution with personal data not yet known (the 72-hour clock
// shows), posts an update with a staff-only note, resolves it and writes the follow-up; the inbox lists it while open.
// READ_ONLY reads it and can't change it. Desktop and phone, with axe. Set E2E_SHOTS to a folder to keep each screen.
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

async function signInNew(page: Page, role: 'SUPPORT' | 'READ_ONLY'): Promise<{ secret: string }> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  return enrol(page);
}

let incidentUrl = '';

test('SUPPORT opens an incident, updates it, resolves it and writes the follow-up', async ({ page }) => {
  const t = await makeInstitution();
  const { secret } = await signInNew(page, 'SUPPORT');
  await tabs(page).getByRole('link', { name: 'Incidents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Incidents' })).toBeVisible();
  await page.getByRole('link', { name: 'Open an incident' }).click();

  await test.step('open it, for one institution, personal data not yet known', async () => {
    await page.getByLabel('What’s wrong').fill('Results pages slow to load');
    await page.getByLabel('SEV2').check();
    await page.getByLabel('Add an institution').fill(t.shortName);
    await page.getByRole('button', { name: `Add ${t.shortName}` }).click();
    await page.getByLabel('What institutions are told').fill('We are looking into slow results pages.');
    await page.getByLabel('Internal note (optional)').fill('Shard 2 pool at its limit (staff only).');
    await expectAccessible(page);
    await shot(page, 'incident-open');
    await page.getByRole('button', { name: 'Open the incident' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Results pages slow to load' })).toBeVisible();
    incidentUrl = page.url();
  });

  await test.step('the clock shows, and the timeline keeps the note apart', async () => {
    await expect(page.getByText(/Personal data: not yet known\. \d+ h \d+ min left/)).toBeVisible();
    await expect(page.getByText('Internal note, staff only')).toBeVisible();
    await expect(page.getByText('Shard 2 pool at its limit (staff only).')).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'incident-page');
  });

  await test.step('the inbox lists it while open', async () => {
    await tabs(page).getByRole('link', { name: /Inbox/ }).click();
    await expect(page.getByRole('link', { name: /SEV2: Results pages slow to load/ })).toBeVisible();
    await page.goto(incidentUrl);
  });

  await test.step('an update, then resolving, then the follow-up', async () => {
    await page.getByLabel('Identified').check();
    await page.getByLabel('No', { exact: true }).check();
    await page.getByLabel('What institutions are told').fill('We found the cause and are fixing it.');
    await page.getByRole('button', { name: 'Post the update' }).click();
    await expect(page.locator('.pc-incident__chips .pc-status').nth(1)).toHaveText('Identified');
    await expect(page.getByText(/Personal data:/)).toHaveCount(0);
    await page.getByLabel('Resolved').check();
    await page.getByLabel('What institutions are told').fill('Fixed. Pages load normally.');
    await page.getByRole('button', { name: 'Resolve the incident' }).click();
    await expect(page.locator('.pc-incident__chips .pc-status').nth(1)).toHaveText('Resolved');
    await expect(page.getByRole('heading', { name: 'Post an update' })).toHaveCount(0);
    await page.getByLabel('What happened').fill('A pool was too small for the peak.');
    await page.getByLabel('What we’re doing about it').fill('Resized; an alert added.');
    await page.getByRole('button', { name: 'Save the follow-up' }).click();
    await expect(page.getByText('Follow-up saved.')).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'incident-resolved');
  });
});

test('READ_ONLY reads an incident and its follow-up, and can change nothing', async ({ page }) => {
  await signInNew(page, 'READ_ONLY');
  await page.goto(incidentUrl);
  await expect(page.getByRole('heading', { level: 1, name: 'Results pages slow to load' })).toBeVisible();
  await expect(page.getByText('A pool was too small for the peak.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Post the update|Save the follow-up/ })).toHaveCount(0);
  await tabs(page).getByRole('link', { name: 'Incidents' }).click();
  await expect(page.getByRole('link', { name: 'Open an incident' })).toHaveCount(0);
  await expectAccessible(page);
});
