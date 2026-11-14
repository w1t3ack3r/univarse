/**
 * Spec 0037 Q14 (T34): an incident at an institution, in a real browser. An open incident affecting test-poly shows its
 * latest public update on test-poly's sign-in page and in its workspace, as plain text, and nowhere at demo-uni; the
 * staff-only note never reaches the page. The incident is written as the migrator (the console's own journey opens one
 * through the console): only the dev chain holds it, so on the stack run this file is skipped.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, cleanup, E2E, hostUrl, makeUser, PASSWORD, randomClientIp } from './fixtures';

const POLY = hostUrl('test-poly');
const DEMO = hostUrl('demo-uni');
const PUBLIC = '<b>Slow</b> results pages: we are on it. Status: https://status.example.test';
const NOTE = 'Shard 2 pool at its limit (staff only)';

let migrator: PlatformClient | undefined;
let authorId = '';
let incidentId = '';

test.skip(E2E.stack, 'the incident is written as the migrator here, which the stack run does not hold');

test.beforeAll(async ({ request }) => {
  const env = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;
  migrator = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
  authorId = (await migrator.platformUser.create({ data: { email: `incidents-${randomBytes(4).toString('hex')}@staff.test`, displayName: 'E2E incidents', role: 'READ_ONLY', isActive: false }, select: { id: true } })).id;
  const poly = await migrator.tenant.findUniqueOrThrow({ where: { slug: 'test-poly' }, select: { id: true } });
  const now = Date.now();
  const i = await migrator.platformIncident.create({
    data: { title: 'Results pages slow to load', severity: 'SEV2', scope: 'TENANTS', startedAt: new Date(now - 3_600_000), awareAt: new Date(now - 1_800_000), openedBy: authorId },
    select: { id: true },
  });
  incidentId = i.id;
  await migrator.platformIncidentUpdate.create({ data: { incidentId, status: 'INVESTIGATING', severity: 'SEV2', personalData: 'UNKNOWN', publicText: PUBLIC, internalNote: NOTE, postedBy: authorId } });
  await migrator.platformIncidentTenant.create({ data: { incidentId, tenantId: poly.id } });
  // The row reaches the API through the worker's relay; wait until this host serves it.
  const edge = new URL(POLY);
  const host = edge.host;
  edge.hostname = '127.0.0.1';
  const served = async () => {
    const res = await request.get(new URL('/api/v1/tenant/incidents', edge).href, { headers: { host } });
    return ((await res.json()) as { data: { id: string }[] }).data.map((d) => d.id);
  };
  await expect.poll(served, { timeout: 20_000 }).toContain(incidentId);
});

test.afterAll(async () => {
  if (migrator) {
    await migrator.platformIncidentTenant.deleteMany({ where: { incidentId } });
    // The timeline is append-only for every purpose but this clean-up of a test's own rows.
    await migrator.$executeRaw`ALTER TABLE platform_incident_update DISABLE TRIGGER platform_incident_update_append_only`;
    try {
      await migrator.platformIncidentUpdate.deleteMany({ where: { incidentId } });
    } finally {
      await migrator.$executeRaw`ALTER TABLE platform_incident_update ENABLE TRIGGER platform_incident_update_append_only`;
    }
    await migrator.platformIncident.deleteMany({ where: { id: incidentId } });
    await migrator.platformUser.deleteMany({ where: { id: authorId } });
    await migrator.$disconnect();
  }
  await cleanup();
});

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

async function seriousA11yViolations(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

const status = (page: Page) => page.getByRole('region', { name: 'Service status' });

test('[Q14][T34] the sign-in page shows the incident as plain text, never its note, and passes axe', async ({ page }) => {
  await page.goto(`${POLY}/login`);
  const item = status(page).getByRole('listitem').filter({ hasText: 'Results pages slow to load' });
  await expect(item).toBeVisible();
  await expect(item.getByText(PUBLIC, { exact: true })).toBeVisible();
  await expect(item.locator('b')).toHaveCount(0);
  await expect(item.getByText(/Investigating/)).toBeVisible();
  await expect(page.getByText(NOTE)).toHaveCount(0);
  expect(await seriousA11yViolations(page)).toEqual([]);
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/incident-signin-${test.info().project.name}.png`, fullPage: true });
});

test('[Q14] the workspace shows it too, to everyone there; another institution shows nothing', async ({ page }) => {
  const student = await makeUser('test-poly', { role: 'STUDENT' });
  await page.goto(`${POLY}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(student.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${POLY}/workspace`);
  await expect(status(page).getByText('Results pages slow to load')).toBeVisible();
  expect(await seriousA11yViolations(page)).toEqual([]);
  await page.goto(`${DEMO}/login`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(status(page)).toHaveCount(0);
});
