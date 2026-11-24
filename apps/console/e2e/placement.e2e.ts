// Spec 0039 Q7 (as the owner changed it, 2026-11-24): the New institution form's level. Pooled is chosen at first; a
// dedicated database is refused at once, in plain words beside the choice and above the form, when none is ready, and
// nothing is created. The development database may hold ready databases, so the test holds every one of them locked
// (as another request's claim would) while it asks: the real API answers. A dedicated institution's provisioning end to
// end is the API's integration test (dedicated.int.spec.ts) and the owner's check on the stack (criterion 9). Desktop
// and phone, with axe.
import { expect, test } from '@playwright/test';
import { createPlatformClient } from '@univarse/db';
import { randomBytes } from 'node:crypto';
import { expectAccessible } from './a11y';
import {
  E2E_PROVISIONED_PREFIX,
  enrol,
  makeMember,
  migratorUrl,
  PASSWORD,
  randomClientIp,
  totp,
} from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test('[Q7] the level: pooled at first, and a dedicated database refused while none is ready', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const tag = randomBytes(4).toString('hex');
  const slug = `${E2E_PROVISIONED_PREFIX}${tag}`;
  const { email } = await makeMember('OWNER');
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/, { timeout: 20_000 });
  const { secret } = await enrol(page);

  await page.goto('/institutions/new');
  const level = page.getByRole('group', { name: 'Where its data lives' });
  await expect(level.getByRole('radio', { name: /^Pooled/ })).toBeChecked();
  await expect(level.getByRole('radio', { name: /^Dedicated database/ })).not.toBeChecked();
  await expectAccessible(page);

  await page.getByLabel('Legal name').fill(`E2E Dedicated University ${tag}`);
  await page.getByLabel('Short name').fill(`EDU${tag}`.toUpperCase());
  await page.getByLabel('Subdomain').fill(slug);
  await page.getByLabel('Full name').fill('Chidi Nwosu');
  await page.getByLabel('Email', { exact: true }).fill(`ict-${tag}@e2e-prov.test`);
  await page.getByLabel('Username', { exact: true }).fill('ictadmin');
  await level.getByRole('radio', { name: /^Dedicated database/ }).check();

  const migrator = createPlatformClient(migratorUrl());
  try {
    await migrator.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM shard WHERE kind = 'DEDICATED' AND status = 'READY' FOR UPDATE`;
        await page.getByRole('button', { name: 'Create the institution' }).click();
        const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
        await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, 1));
        await expect(dialog).toBeHidden();
        await expect(
          level.getByText(
            'No dedicated database is ready: run pnpm stack:shards ready, then try again.',
          ),
        ).toBeVisible();
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
    await expect(page.getByRole('heading', { level: 1, name: 'New institution' })).toBeVisible();
    expect(await migrator.tenant.count({ where: { slug } })).toBe(0);
    await expectAccessible(page);
  } finally {
    await migrator.$disconnect();
  }
});
