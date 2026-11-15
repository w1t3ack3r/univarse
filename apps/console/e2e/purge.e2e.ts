// Spec 0038 Q9, Q12, Q15 (PR C): an archived institution's purge in the console. An OWNER asks for it on the institution's
// page, after a step-up; a SUPER_ADMIN, in a browser of their own, approves exactly that institution; the page then shows
// the authorisation and the host command (nothing is deleted from the console). A purged institution (its run recorded
// as the host's job would, as the migrator) leads with its certificate. Desktop and phone, with axe. Set E2E_SHOTS to a
// folder to keep a screenshot of each screen.
import { createHash, randomUUID } from 'node:crypto';
import { createPlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { enrol, makeInstitution, makeMember, migratorUrl, PASSWORD, randomClientIp, totp } from './fixtures';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Console' });
const shot = async (page: Page, name: string) => {
  const dir = process.env.E2E_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${test.info().project.name}.png`, fullPage: true });
};

async function signInNew(page: Page, role: 'OWNER' | 'SUPER_ADMIN'): Promise<{ secret: string }> {
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

/** Closes an institution as the worker would have, after its 60 days. */
async function archived(): Promise<Awaited<ReturnType<typeof makeInstitution>>> {
  const t = await makeInstitution();
  const db = createPlatformClient(migratorUrl());
  try {
    const owner = await db.platformUser.findFirstOrThrow({ where: { role: 'OWNER', isActive: true }, select: { id: true } });
    const started = new Date(Date.now() - 61 * 86_400_000);
    const ended = new Date(Date.now() - 86_400_000);
    await db.tenant.update({ where: { id: t.id }, data: { status: 'ARCHIVED', offboardingStartedAt: started, purgeAfter: ended } });
    await db.platformTenantOffboarding.create({
      data: { tenantId: t.id, reason: 'CONTRACT_ENDED', previousStatus: 'ACTIVE', startedBy: owner.id, startedAt: started, firstEndsAt: ended, endsAt: ended, archivedAt: ended, sessionsEndedAt: ended },
    });
  } finally {
    await db.$disconnect();
  }
  return t;
}

test('a purge takes two people: one asks on the institution’s page, another approves exactly that one', async ({ browser, page, context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
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
  const t = await archived();

  await test.step('an OWNER asks for it, after a step-up, told it can’t be undone', async () => {
    await page.goto(`/institutions/${t.id}`);
    const closed = page.getByRole('region', { name: 'Closed' });
    await expect(closed.getByText('Deleting its data')).toBeVisible();
    await closed.getByText('Ask for its purge').click();
    await expect(closed.getByText(/It can’t be undone/)).toBeVisible();
    await closed.getByLabel('Why now?').fill('Its window is over and it took its export.');
    await expectAccessible(page);
    await shot(page, 'purge-ask');
    await closed.getByRole('button', { name: `Ask for ${t.shortName}’s purge` }).click();
    await confirm(page, secret);
    await expect(page.getByText(`Asked for ${t.shortName}’s purge.`)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Closed' }).getByText(/Waiting for a second person/)).toBeVisible();
  });

  await test.step('the second person approves exactly that institution, after a step-up', async () => {
    await second.goto('/approvals');
    await second.getByRole('link', { name: new RegExp(`Authorise the purge of ${t.slug}`) }).first().click();
    await expect(second.getByRole('heading', { level: 1, name: `Authorise the purge of ${t.slug}` })).toBeVisible();
    await expect(second.getByText(/Nothing is deleted yet/)).toBeVisible();
    await expectAccessible(second);
    await shot(second, 'purge-approve');
    await second.getByRole('button', { name: `Approve: authorise the purge of ${t.slug}` }).click();
    await confirm(second, secondSecret);
    await expect(second.getByText('Approved and done').first()).toBeVisible();
  });

  await test.step('the page shows the authorisation and the host command, and the inbox lists it', async () => {
    await page.goto(`/institutions/${t.id}`);
    const closed = page.getByRole('region', { name: 'Closed' });
    await expect(closed.getByText(/Authorised: asked by/)).toBeVisible();
    await expect(closed.getByText(`pnpm stack:purge ${t.slug}`, { exact: true })).toBeVisible();
    await expect(closed.getByRole('button', { name: 'Copy' })).toBeVisible();
    await expectAccessible(page);
    await shot(page, 'purge-authorised');
    await tabs(page).getByRole('link', { name: /Inbox/ }).click();
    await expect(page.getByRole('link', { name: new RegExp(`${t.shortName}: its purge is authorised`) })).toBeVisible();
  });
  await other.close();
});

test('a purged institution leads with its certificate', async ({ page, context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
  await signInNew(page, 'OWNER');
  const t = await archived();
  // The host's job recorded every step and the certificate (a solo run, as nobody else could approve it).
  const certificate = {
    format: 'univarse-purge-certificate-1',
    institution: { id: t.id, slug: t.slug, legalName: t.legalName, type: 'POLYTECHNIC' },
    authority: { solo: true, reason: 'The only owner, before a second member joins' },
    lastBackupGoneBy: '2027-01-08',
  };
  const json = `${JSON.stringify(certificate, null, 2)}\n`;
  const sha = createHash('sha256').update(json).digest('hex');
  const db = createPlatformClient(migratorUrl());
  try {
    const at = new Date();
    await db.platformTenantPurge.create({
      data: {
        tenantId: t.id,
        solo: true,
        reason: 'The only owner, before a second member joins',
        keysOp: randomUUID(),
        keysDestroyedAt: at,
        rows: { user_account: 3 },
        rowsDeletedAt: at,
        objects: { 'uv-clean': 2 },
        objectsDeletedAt: at,
        platformRows: { tenant_domain: 1 },
        platformDeletedAt: at,
        certificate,
        certificateSha256: sha,
        certificateAt: at,
      },
    });
    await db.tenant.update({ where: { id: t.id }, data: { status: 'PURGED', purgedAt: at, purgeCertificateSha256: sha } });
  } finally {
    await db.$disconnect();
  }
  await page.goto(`/institutions/${t.id}`);
  const purged = page.getByRole('region', { name: 'Purged' });
  await expect(purged).toBeVisible();
  await expect(purged.getByText(/One person, as nobody else could approve it/)).toBeVisible();
  await expect(purged.getByText(/deleted by 2027-01-08/)).toBeVisible();
  await expect(purged.getByText(`SHA-256 ${sha}`)).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'purged');
  const [download] = await Promise.all([page.waitForEvent('download'), purged.getByRole('button', { name: 'Download the certificate' }).click()]);
  expect(download.suggestedFilename()).toBe(`${t.slug}-certificate-of-deletion.json`);
});
