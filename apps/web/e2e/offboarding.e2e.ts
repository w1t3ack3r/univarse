/**
 * Spec 0038 Q3, Q5: what an institution's people see as it leaves. While it's offboarding, its sign-in page says the day
 * its account closes; once archived, its address says the account has closed, in its name, not "not found". The two
 * institutions here are made as the migrator for this file (the 60 days can't pass in a test) and removed after: only
 * the dev chain holds it, so on the stack run this file is skipped.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, E2E, randomClientIp } from './fixtures';

let migrator: PlatformClient | undefined;
const made: string[] = [];
let leaving = '';
let closed = '';

test.skip(E2E.stack, 'the institutions are made as the migrator here, which the stack run does not hold');

async function institution(status: 'OFFBOARDING' | 'ARCHIVED', name: string): Promise<string> {
  const db = migrator!;
  const slug = `e2e-off-${randomBytes(4).toString('hex')}`;
  const shard = await db.shard.findFirstOrThrow({ select: { id: true } });
  const closesAt = new Date(Date.now() + (status === 'OFFBOARDING' ? 20 : -1) * 86_400_000);
  const t = await db.tenant.create({
    data: { slug, legalName: name, shortName: 'LEAVING', type: 'POLYTECHNIC', ownership: 'STATE', status, shardId: shard.id, offboardingStartedAt: new Date(), purgeAfter: closesAt },
    select: { id: true },
  });
  await db.tenantDomain.create({ data: { tenantId: t.id, hostname: `${slug}.univarse.localhost`, kind: 'SUBDOMAIN', verifiedAt: new Date() } });
  made.push(t.id);
  return E2E.origin(slug);
}

test.beforeAll(async () => {
  const env = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;
  migrator = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
  leaving = await institution('OFFBOARDING', 'Leaving Polytechnic of Testing');
  closed = await institution('ARCHIVED', 'Closed Polytechnic of Testing');
});

test.afterAll(async () => {
  if (migrator) {
    await migrator.tenantDomain.deleteMany({ where: { tenantId: { in: made } } });
    await migrator.tenant.deleteMany({ where: { id: { in: made } } });
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

test('[Q3] an offboarding institution’s sign-in page works, and says when its account closes', async ({ page }) => {
  await page.goto(`${leaving}/login`);
  const banner = page.getByRole('region', { name: 'Account closing' });
  await expect(banner.getByText(/UniVarse closes for Leaving Polytechnic of Testing at the end of/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await seriousA11yViolations(page)).toEqual([]);
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/closing-${test.info().project.name}.png`, fullPage: true });
});

test('[Q5] an archived institution’s address says the account has closed, in its name', async ({ page }) => {
  await page.goto(`${closed}/login`);
  await expect(page.getByRole('heading', { level: 1, name: 'This account has closed' })).toBeVisible();
  await expect(page.getByText('Closed Polytechnic of Testing')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
  await expect(page.getByText(/not found/i)).toHaveCount(0);
  expect(await seriousA11yViolations(page)).toEqual([]);
  await page.goto(`${closed}/workspace`);
  await expect(page).toHaveURL(`${closed}/login`);
  await expect(page.getByRole('heading', { level: 1, name: 'This account has closed' })).toBeVisible();
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/closed-${test.info().project.name}.png`, fullPage: true });
});
