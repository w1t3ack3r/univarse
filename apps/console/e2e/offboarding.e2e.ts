// Spec 0038 Q2–Q6, Q15: an OWNER starts an institution's offboarding with a reason, after a step-up; the page leads with
// the days left and the warnings its IT Admins were sent; cancelling returns it to live. An archived institution (set up
// as the migrator: the 60 days can't pass in a test) shows as closed and takes one 14-day extension. Desktop and phone,
// with axe. Set E2E_SHOTS to a folder to keep a screenshot of each screen.
import { randomUUID } from 'node:crypto';
import { createPlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { enrol, makeInstitution, makeMember, migratorUrl, PASSWORD, randomClientIp, totp } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

const shot = async (page: Page, name: string) => {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png`, fullPage: true });
};

async function signInOwner(page: Page): Promise<{ secret: string; email: string }> {
  const { email } = await makeMember('OWNER');
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  return { ...(await enrol(page)), email };
}

const confirm = async (page: Page, secret: string) => {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
  await expect(dialog).toBeHidden();
};

test('an OWNER starts an institution’s offboarding, sees its warnings, and cancels it', async ({ page }) => {
  const t = await makeInstitution();
  const { secret } = await signInOwner(page);
  await page.goto(`/institutions/${t.id}`);

  await test.step('starting asks why, says what happens, and takes a step-up', async () => {
    await page.getByText(`Start offboarding ${t.shortName}`, { exact: true }).first().click();
    const form = page.locator('form').filter({ has: page.getByRole('group', { name: 'Why is it leaving?' }) });
    await expect(form.getByRole('button', { name: `Start offboarding ${t.shortName}` })).toBeDisabled();
    await form.getByLabel('The contract ended').check();
    await expectAccessible(page);
    await shot(page, 'offboarding-start');
    await form.getByRole('button', { name: `Start offboarding ${t.shortName}` }).click();
    await confirm(page, secret);
    await expect(page.getByText(`${t.shortName} is leaving.`)).toBeVisible();
  });

  await test.step('the page leads with the days left and the warnings sent', async () => {
    const section = page.getByRole('region', { name: /Leaving:/ });
    await expect(section).toBeVisible();
    await expect(section.getByText('The contract ended')).toBeVisible();
    // The worker sends the first warning within a second or two here; the page shows it on reload.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole('region', { name: /Leaving:/ }).getByRole('cell', { name: 'The start' })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.locator('.pc-section__head .pc-status').first()).toHaveText('Offboarding');
    // Spec 0038 Q15: no export asked for yet, and staff can't take one for them.
    await expect(page.getByRole('region', { name: /Leaving:/ }).getByText(/haven’t asked for an export yet/)).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'offboarding-leaving');
  });

  await test.step('cancelling returns it to live, and nothing was lost', async () => {
    await page.getByRole('button', { name: 'Cancel the offboarding' }).click();
    await expect(page.getByText(`${t.shortName} is staying.`)).toBeVisible();
    await expect(page.locator('.pc-section__head .pc-status').first()).toHaveText('Active');
  });
});

test('an archived institution shows as closed, and takes one 14-day extension', async ({ page }) => {
  const t = await makeInstitution();
  const { secret, email } = await signInOwner(page);
  // The 60 days can't pass in a test: archive it as the migrator, as the worker would have.
  const db = createPlatformClient(migratorUrl());
  try {
    const owner = await db.platformUser.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const started = new Date(Date.now() - 61 * 86_400_000);
    const ended = new Date(Date.now() - 86_400_000);
    await db.tenant.update({ where: { id: t.id }, data: { status: 'ARCHIVED', offboardingStartedAt: started, purgeAfter: ended } });
    await db.platformTenantOffboarding.create({
      data: { tenantId: t.id, reason: 'INSTITUTION_ASKED', previousStatus: 'ACTIVE', startedBy: owner.id, startedAt: started, firstEndsAt: ended, endsAt: ended, archivedAt: ended, sessionsEndedAt: ended },
    });
    // Spec 0038 Q15: an export it took in its window, as the worker mirrors one: state and counts only.
    const readyAt = new Date(Date.now() - 3 * 86_400_000);
    await db.platformTenantExport.create({
      data: { id: randomUUID(), tenantId: t.id, state: 'READY', requestedAt: readyAt, readyAt, expiresAt: new Date(readyAt.getTime() + 7 * 86_400_000), sizeBytes: 2_450_000n, tables: 12, rows: 18_204n, files: 37 },
    });
  } finally {
    await db.$disconnect();
  }
  await page.goto(`/institutions/${t.id}`);
  const section = page.getByRole('region', { name: 'Closed' });
  await expect(section).toBeVisible();
  await expect(section.getByText(/Ended/)).toBeVisible();
  await expect(section.getByText('Ready to download', { exact: false })).toBeVisible();
  await expect(section.getByText('2.5 MB: 18,204 records in 12 tables, 37 documents')).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'offboarding-closed');

  await section.getByText('Give it 14 more days').click();
  await section.getByLabel('Why?').fill('They missed their export');
  await section.getByRole('button', { name: `Give ${t.shortName} 14 more days` }).click();
  await confirm(page, secret);
  await expect(page.getByText(`${t.shortName} is open again for 14 days.`)).toBeVisible();
  const leaving = page.getByRole('region', { name: /Leaving:/ });
  await expect(leaving.getByText(/Extended/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel the offboarding' })).toBeVisible();
});
