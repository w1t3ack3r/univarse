/**
 * Spec 0037 Q10 (T34): notices at an institution, in a real browser. A maintenance notice shows to everyone at
 * test-poly (its sign-in page and its workspace) and nowhere at demo-uni; an announcement shows to IT Admins only;
 * markup in a notice shows as the characters it is, and runs nothing; a person dismisses a banner for themselves.
 * The notices are written as the migrator (the console's own journey publishes through the console): only the dev
 * chain holds it, so on the stack run this file is skipped and criterion 12 (the owner's check) covers the stack.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, cleanup, clearReplayGuardFor, currentTotp, E2E, hostUrl, makeUser, PASSWORD, randomClientIp, type TestUser } from './fixtures';

const POLY = hostUrl('test-poly');
const DEMO = hostUrl('demo-uni');
const MARKUP = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2"> Details: https://status.example.test/maintenance';

let migrator: PlatformClient | undefined;
let authorId: string;
const notices: string[] = [];
let maintenance: string;

test.skip(E2E.stack, 'notices are written as the migrator here, which the stack run does not hold');

async function publish(tenantSlug: 'test-poly', kind: 'MAINTENANCE' | 'ANNOUNCEMENT', title: string, body: string): Promise<string> {
  const db = migrator!;
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: tenantSlug }, select: { id: true } });
  const now = Date.now();
  const window = kind === 'MAINTENANCE' ? { startsAt: new Date(now + 2 * 3_600_000), endsAt: new Date(now + 4 * 3_600_000) } : {};
  const n = await db.platformNotice.create({
    data: { kind, title, body, audience: 'TENANTS', tenantIds: [tenant.id], ...window, createdBy: authorId },
    select: { id: true },
  });
  await db.platformNotice.update({
    where: { id: n.id },
    data: { status: 'PUBLISHED', publishedAt: new Date(now), publishedBy: authorId, shownUntil: kind === 'MAINTENANCE' ? window.endsAt! : new Date(now + 14 * 86_400_000) },
  });
  await db.platformNoticeDelivery.create({ data: { noticeId: n.id, tenantId: tenant.id } });
  notices.push(n.id);
  return n.id;
}

test.beforeAll(async ({ request }) => {
  const env = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;
  migrator = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
  // A retired test member as the author: the platform's own clean-up removes it and what it wrote.
  authorId = (await migrator.platformUser.create({ data: { email: `notices-${randomBytes(4).toString('hex')}@staff.test`, displayName: 'E2E notices', role: 'READ_ONLY', isActive: false }, select: { id: true } })).id;
  maintenance = await publish('test-poly', 'MAINTENANCE', 'Planned maintenance tonight', MARKUP);
  await publish('test-poly', 'ANNOUNCEMENT', 'New results screens for IT Admins', 'From Monday, results open in the new screens.\nAsk us if anything looks wrong.');
  // The delivery reaches the API through the worker's relay; wait until this host serves it.
  const edge = new URL(POLY);
  const host = edge.host;
  edge.hostname = '127.0.0.1';
  const served = async () => {
    const res = await request.get(new URL('/api/v1/tenant/notices', edge).href, { headers: { host } });
    return ((await res.json()) as { data: { id: string }[] }).data.map((d) => d.id);
  };
  await expect.poll(served, { timeout: 20_000 }).toContain(maintenance);
});

test.afterAll(async () => {
  if (migrator) {
    await migrator.platformNoticeDelivery.deleteMany({ where: { noticeId: { in: notices } } });
    await migrator.platformNotice.deleteMany({ where: { id: { in: notices } } });
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

const region = (page: Page) => page.getByRole('region', { name: 'Notices from UniVarse' });

async function signIn(page: Page, u: TestUser, mfa: boolean) {
  await page.goto(`${POLY}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (mfa) {
    await expect(page).toHaveURL(`${POLY}/login/verify`);
    await clearReplayGuardFor('test-poly', u.username);
    await page.getByLabel('6-digit code').fill(currentTotp(u));
  }
  await expect(page).toHaveURL(`${POLY}/workspace`);
}

test('[Q10][T34] the sign-in page shows maintenance as plain text, runs nothing, and passes axe', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.goto(`${POLY}/login`);
  const banner = region(page).getByRole('listitem').filter({ hasText: 'Planned maintenance tonight' });
  await expect(banner).toBeVisible();
  // The characters, exactly: no element was made from them.
  await expect(banner.getByText(MARKUP, { exact: true })).toBeVisible();
  await expect(banner.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
  await expect(banner.getByText(/Nigerian time/)).toBeVisible();
  // Not signed in: nothing for IT Admins, and nothing to dismiss.
  await expect(region(page).getByText('New results screens for IT Admins')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Dismiss/ })).toHaveCount(0);
  expect(await seriousA11yViolations(page)).toEqual([]);
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/notice-signin-${test.info().project.name}.png`, fullPage: true });
});

test('[Q10] another institution shows neither', async ({ page }) => {
  await page.goto(`${DEMO}/login`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(region(page)).toHaveCount(0);
});

test('[Q10] an IT Admin sees both in the workspace; dismissing one hides it for them only', async ({ browser, page }) => {
  const admin = await makeUser('test-poly', { role: 'INSTITUTION_ADMIN', mfa: true });
  await signIn(page, admin, true);
  await expect(region(page).getByText('New results screens for IT Admins')).toBeVisible();
  await expect(region(page).getByText('Planned maintenance tonight')).toBeVisible();
  // Line breaks are kept.
  await expect(region(page).getByText(/From Monday, results open in the new screens\.\s*Ask us/)).toBeVisible();
  expect(await seriousA11yViolations(page)).toEqual([]);
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/notice-workspace-${test.info().project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: 'Dismiss: New results screens for IT Admins' }).click();
  await expect(region(page).getByText('New results screens for IT Admins')).toHaveCount(0);
  await page.reload();
  await expect(region(page).getByText('New results screens for IT Admins')).toHaveCount(0);
  await expect(region(page).getByText('Planned maintenance tonight')).toBeVisible();

  // Another IT Admin still sees it.
  const other = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': randomClientIp() } });
  const second = await other.newPage();
  await signIn(second, await makeUser('test-poly', { role: 'INSTITUTION_ADMIN', mfa: true }), true);
  await expect(region(second).getByText('New results screens for IT Admins')).toBeVisible();
  await other.close();
});

test('[Q10] a student sees maintenance only', async ({ page }) => {
  const student = await makeUser('test-poly', { role: 'STUDENT' });
  await signIn(page, student, false);
  await expect(region(page).getByText('Planned maintenance tonight')).toBeVisible();
  await expect(region(page).getByText('New results screens for IT Admins')).toHaveCount(0);
});
