// Spec 0034 Q15, J1: an OWNER creates an institution in the console, watches it provisioned by the worker, completes the
// go-live checklist and takes it live, within ten minutes. The first administrator's invitation is read from Mailpit.
// Their activation and authenticator are the tenant web app's own journey (apps/web/e2e/flows.e2e.ts), so here the
// administrator's readiness is set on the tenant side directly, exactly as the worker's check reads it. Desktop and
// phone, with axe.
import { expect, test, type Page } from '@playwright/test';
import { createTenantShardClient, withTenantTx } from '@univarse/db';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expectAccessible } from './a11y';
import { E2E_PROVISIONED_PREFIX, enrol, makeMember, PASSWORD, randomClientIp, totp } from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test.describe.configure({ mode: 'serial', timeout: 600_000 });

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';
const rootEnv = () => parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;

async function signInOwner(page: Page): Promise<{ secret: string }> {
  const { email } = await makeMember('OWNER');
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/, { timeout: 20_000 }); // the run's first sign-in waits on a cold platform API
  return enrol(page);
}

/** The invitation the worker sent `to`, from Mailpit: its text. Polls for up to 30 s. */
async function invitation(to: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await res.json()) as { messages: { ID: string }[] };
    const first = list.messages[0];
    if (first) return ((await (await fetch(`${MAILPIT}/api/v1/message/${first.ID}`)).json()) as { Text: string }).Text;
    if (Date.now() > deadline) throw new Error(`No invitation reached ${to} within 30 s`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** What the administrator's own activation and authenticator set-up leave behind, as the worker's check reads it. */
async function administratorReady(tenantId: string): Promise<void> {
  const shard = createTenantShardClient(rootEnv().TENANT_POOL_01_DATABASE_URL!);
  try {
    await withTenantTx(shard, tenantId, async (tx) => {
      const u = await tx.userAccount.findFirstOrThrow({ select: { id: true } });
      await tx.userAccount.update({ where: { id: u.id }, data: { status: 'ACTIVE' } });
      await tx.mfaFactor.create({ data: { tenantId, userId: u.id, type: 'TOTP', secretEnc: 'e2e-not-a-secret', confirmedAt: new Date() } });
    });
  } finally {
    await shard.$disconnect();
  }
}

test('[J1] create → provisioned → the checklist → live, in under ten minutes', async ({ page }) => {
  const started = Date.now();
  const tag = randomBytes(4).toString('hex');
  const slug = `${E2E_PROVISIONED_PREFIX}${tag}`;
  const adminEmail = `ict-${tag}@e2e-prov.test`;
  const { secret } = await signInOwner(page);
  let step = 1;
  const confirm = async () => {
    const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await dialog.getByLabel('Code from your authenticator app').fill(totp(secret, step++));
    await expect(dialog).toBeHidden();
  };

  await test.step('the form, from the institutions list', async () => {
    await page.getByRole('navigation', { name: 'Console' }).getByRole('link', { name: 'Institutions' }).click();
    await page.getByRole('link', { name: 'New institution' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New institution' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'The steps of provisioning' }).getByRole('listitem')).toHaveCount(8);
    await expectAccessible(page);

    await page.getByLabel('Legal name').fill(`E2E Polytechnic ${tag}`);
    await page.getByLabel('Short name').fill(`EP${tag}`.toUpperCase());
    await page.getByLabel('Subdomain').fill('Bad_Slug');
    await expect(page.getByText('Use 3 to 40 lower-case letters')).toBeVisible();
    await page.getByLabel('Subdomain').fill(slug);
    await page.getByLabel('Type', { exact: true }).selectOption('POLYTECHNIC');
    await expect(page.getByLabel('Template')).toHaveValue('polytechnic'); // the type proposes it
    await page.getByLabel('State').selectOption('Ogun');
    await page.getByLabel('Full name').fill('Adaeze Okafor');
    await page.getByLabel('Email', { exact: true }).fill(adminEmail);
    await page.getByLabel('Username', { exact: true }).fill('ictadmin');
    await page.getByRole('checkbox', { name: /Academics/ }).check();
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create the institution' }).click();
    await confirm();
  });

  await test.step('provisioned by the worker, and the invitation sent', async () => {
    await expect(page.getByRole('heading', { level: 1, name: `E2E Polytechnic ${tag}` })).toBeVisible();
    await expect(page.getByText(/^Finished .* from the polytechnic@1 template\. The invitation went to i•••@e2e-prov\.test\.$/)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Onboarding', { exact: true }).first()).toBeVisible();
    await page.getByText('Show the steps').click();
    await expect(page.getByRole('list', { name: 'Provisioning steps' }).getByRole('listitem')).toHaveCount(8);
    await expectAccessible(page);
    const text = await invitation(adminEmail);
    expect(text).toContain('Your username: ICTADMIN');
    expect(text).toContain(`${slug}.univarse.localhost:4180/activate`);
  });

  await test.step('the checklist, item by item', async () => {
    const golive = page.getByRole('region', { name: 'Going live' });
    // Academics was granted at creation; the state alone doesn't complete the regulatory item.
    await expect(golive.getByText(/^1 of 5 done\./)).toBeVisible();
    const take = page.getByRole('button', { name: `Take EP${tag.toUpperCase()} live` });
    await expect(take).toBeDisabled();

    await page.locator('#b-hex').fill('#1A3A6B');
    await page.getByRole('button', { name: 'Save the colour' }).click(); // within the step-up's 5 minutes: no second ask
    await expect(page.getByText('The colour is saved.')).toBeVisible();

    await page.getByLabel('Operating status').selectOption('APPROVED');
    await page.getByRole('button', { name: 'Save the regulatory details' }).click();
    await expect(page.getByText('The regulatory details are saved.')).toBeVisible();

    await page.locator('summary', { hasText: 'Record the signed agreement' }).click();
    await page.getByLabel('Agreement version').fill('v1.0');
    await page.getByLabel('Date signed').fill(new Date().toISOString().slice(0, 10));
    await page.getByLabel('Reference', { exact: true }).fill(`DPA-${tag}`);
    await page.getByRole('button', { name: 'Record the agreement' }).click();
    await expect(page.getByText(`reference DPA-${tag}`)).toBeVisible();

    const tenantId = new URL(page.url()).pathname.split('/').at(-1)!;
    await administratorReady(tenantId);
    // The worker checks every second; the page reads the checklist again when the institution changes.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText('Everything is in place.')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 60_000 });
    await expectAccessible(page);
  });

  await test.step('live', async () => {
    await page.getByRole('button', { name: `Take EP${tag.toUpperCase()} live` }).click();
    await expect(page.getByText(`EP${tag.toUpperCase()} is live.`)).toBeVisible();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Going live' })).toBeHidden();
  });

  expect(Date.now() - started).toBeLessThan(600_000);
});
