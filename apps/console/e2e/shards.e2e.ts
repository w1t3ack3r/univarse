// Spec 0039 Q12, acceptance 8: the console's Shards page, its inbox item and an institution's level. An OWNER reads
// the page (what needs attention, the server's budget in words, every shard), and a scratch shard put in maintenance
// (a registered row with no database behind it: the console never opens one) shows in the inbox, linked to the page.
// SUPPORT has neither the page nor its place in the navigation. Desktop and phone, with axe. The scratch rows go.
import { expect, test, type Page } from '@playwright/test';
import { createPlatformClient } from '@univarse/db';
import { randomBytes } from 'node:crypto';
import { expectAccessible } from './a11y';
import { enrol, makeInstitution, makeMember, migratorUrl, PASSWORD, randomClientIp } from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

async function signIn(page: Page, role: 'OWNER' | 'SUPPORT'): Promise<void> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/, { timeout: 20_000 });
  await enrol(page);
}

test('[Q12] an OWNER reads the Shards page, sees a shard in maintenance in the inbox, and an institution’s level', async ({ page }) => {
  test.setTimeout(120_000);
  const migrator = createPlatformClient(migratorUrl());
  const s = randomBytes(6).toString('hex');
  const server = await migrator.dbServer.findUniqueOrThrow({ where: { name: 'local' }, select: { id: true } });
  const down = await migrator.shard.create({
    data: { name: `t-${s}`, kind: 'DEDICATED', secretRef: 'UNUSED_DATABASE_URL', region: 'local', serverId: server.id, database: `univarse_t_${s}`, capacity: 1, poolSize: 3, status: 'MAINTENANCE' },
    select: { id: true, name: true },
  });
  try {
    const institution = await makeInstitution();
    await signIn(page, 'OWNER');

    await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Shards' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Shards' })).toBeVisible();
    const attention = page.getByRole('group', { name: /Needs attention/ });
    await expect(attention.getByText(`${down.name} is in maintenance: its last migration failed`)).toBeVisible();
    await expect(page.getByRole('group', { name: /Server local/ }).getByText(/connections in all\. Room for \d+ more dedicated database/)).toBeVisible();
    const pool = page.getByRole('row').filter({ hasText: 'pool-01' });
    await expect(pool.getByText('In service')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: down.name }).getByText('In maintenance')).toBeVisible();
    await expect(page.getByText(/postgres(ql)?:\/\//)).toHaveCount(0);
    await expectAccessible(page);

    await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: /Inbox/ }).click();
    const item = page.getByRole('link', { name: new RegExp(`${down.name} is in maintenance`) });
    await expect(item).toBeVisible();
    await expectAccessible(page);
    await item.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Shards' })).toBeVisible();

    await page.goto(`/institutions/${institution.id}`);
    await expect(page.getByText('Pooled', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'pool-01' })).toHaveAttribute('href', '/shards');
    await expectAccessible(page);
  } finally {
    await migrator.shard.delete({ where: { id: down.id } });
    await migrator.$disconnect();
  }
});

test('[Q12] SUPPORT has no Shards page, nor its place in the navigation', async ({ page }) => {
  await signIn(page, 'SUPPORT');
  await expect(page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Institutions' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Shards' })).toHaveCount(0);
  await page.goto('/shards');
  await expect(page.getByRole('heading', { level: 1, name: 'There’s nothing at this address' })).toBeVisible();
});
