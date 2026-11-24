/**
 * Spec 0039 Q10: an institution whose shard is in maintenance (its last migration failed) says so on its own address,
 * in its own name and colour: "closed for maintenance", with nothing to sign in to, and the workspace sends its people
 * there rather than to an error. The institution here lives on a scratch dedicated shard made as the migrator for this
 * file (its database is never opened: the API refuses first) and removed after; only the dev chain holds the migrator,
 * so on the stack run this file is skipped (criterion 9's drill covers it there).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, E2E, randomClientIp } from './fixtures';

let migrator: PlatformClient | undefined;
let shardId = '';
let tenantId = '';
let origin = '';

test.skip(E2E.stack, 'the institution is made as the migrator here, which the stack run does not hold');

test.beforeAll(async () => {
  const env = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;
  migrator = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
  const suffix = randomBytes(6).toString('hex');
  const slug = `e2e-mnt-${suffix}`;
  const server = await migrator.dbServer.findUniqueOrThrow({ where: { name: 'local' }, select: { id: true } });
  shardId = (
    await migrator.shard.create({
      data: { name: `t-${suffix}`, kind: 'DEDICATED', secretRef: 'UNUSED_DATABASE_URL', region: 'local', serverId: server.id, database: `univarse_t_${suffix}`, capacity: 1, poolSize: 3, status: 'ACTIVE' },
      select: { id: true },
    })
  ).id;
  tenantId = (
    await migrator.tenant.create({
      data: { slug, legalName: 'Maintained Polytechnic of Testing', shortName: 'MPT', type: 'POLYTECHNIC', ownership: 'STATE', status: 'ACTIVE', shardId, tier: 'DEDICATED' },
      select: { id: true },
    })
  ).id;
  // Spec 0039 PR C: placed while the shard is open (the placement trigger), then put in maintenance.
  await migrator.shard.update({ where: { id: shardId }, data: { status: 'MAINTENANCE' } });
  await migrator.tenantDomain.create({ data: { tenantId, hostname: `${slug}.univarse.localhost`, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  await migrator.tenantBranding.create({ data: { tenantId, primaryColor: '#1F4E79' } });
  origin = E2E.origin(slug);
});

test.afterAll(async () => {
  if (migrator) {
    await migrator.tenantBranding.deleteMany({ where: { tenantId } });
    await migrator.tenantDomain.deleteMany({ where: { tenantId } });
    await migrator.tenant.deleteMany({ where: { id: tenantId } });
    await migrator.shard.deleteMany({ where: { id: shardId } });
    await migrator.$disconnect();
  }
});

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

async function seriousA11yViolations(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

const maintenancePage = async (page: Page) => {
  await expect(page.getByRole('heading', { level: 1, name: 'Closed for maintenance' })).toBeVisible();
  await expect(page.getByText('Maintained Polytechnic of Testing')).toBeVisible();
  await expect(page.getByText('This institution’s UniVarse is closed for scheduled maintenance. Please try again shortly.')).toBeVisible();
  await expect(page.getByText(/opens again by itself/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/not found|temporarily unavailable|has closed/i)).toHaveCount(0);
};

test('[Q10] the sign-in page of an institution in maintenance says so, in its name and colour, and passes axe', async ({ page }) => {
  await page.goto(`${origin}/login`);
  await maintenancePage(page);
  // Its colour leads the page, as on its working days.
  const brand = await page.locator('.auth').evaluate((el) => getComputedStyle(el).getPropertyValue('--uv-brand').trim().toLowerCase());
  expect(brand).toBe('#1f4e79');
  expect(await seriousA11yViolations(page)).toEqual([]);
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/maintenance-${test.info().project.name}.png`, fullPage: true });
});

test('[Q10] its workspace and its other sign-in pages lead to the same page, not an error', async ({ page }) => {
  await page.goto(`${origin}/workspace`);
  await expect(page).toHaveURL(`${origin}/login`);
  await maintenancePage(page);
  await page.goto(`${origin}/reset-password`);
  await maintenancePage(page);
});
