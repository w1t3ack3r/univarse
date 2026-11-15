/**
 * Spec 0038 Q7, Q8 (criterion 4 in the browser): an IT Admin takes the institution's export. They confirm it's them,
 * ask for it, keep the passphrase (shown once), wait while the worker prepares it, download it and open it with the
 * passphrase. Desktop and phone, axe on every state. The demo institution's recent exports are cleared before (one a
 * day) and after, as the tenant migrator, which only the dev chain holds: on the stack run this file is skipped.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import AxeBuilder from '@axe-core/playwright';
import { createPlatformClient } from '@univarse/db';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { clearRecentExports, openExport } from '../../api/src/testing/export-helpers.js';
import { animationsSettled, cleanup, clearReplayGuardFor, currentTotp, E2E, hostUrl, makeUser, navTo, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');
const env = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;
let demoId = '';

test.skip(E2E.stack, 'the demo institution\'s exports are cleared as the tenant migrator, which the stack run does not hold');

test.beforeAll(async () => {
  const platform = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
  demoId = (await platform.tenant.findUniqueOrThrow({ where: { slug: 'demo-uni' }, select: { id: true } })).id;
  await platform.$disconnect();
  await clearRecentExports(env, demoId);
});

test.afterAll(async () => {
  if (demoId) await clearRecentExports(env, demoId);
  await cleanup();
});

async function seriousA11y(page: Page): Promise<string[]> {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

type User = Awaited<ReturnType<typeof makeUser>>;

async function signedIn(browser: Browser, viewport: { width: number; height: number } | null): Promise<{ page: Page; u: User }> {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), extraHTTPHeaders: { 'x-forwarded-for': randomClientIp() }, acceptDownloads: true });
  const page = await context.newPage();
  const u = await makeUser('demo-uni', { role: 'INSTITUTION_ADMIN', mfa: true });
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // This file's first sign-in meets a cold API (password hashing measured at ~2 s on a loaded laptop, with spikes).
  await expect(page).toHaveURL(`${DEMO}/login/verify`, { timeout: 20_000 });
  await page.getByLabel('6-digit code').fill(currentTotp(u));
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  return { page, u };
}

async function confirmItsMe(page: Page, u: User) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await clearReplayGuardFor('demo-uni', u.username);
  await dialog.getByLabel('Your password').fill(PASSWORD);
  await dialog.getByLabel('Code from your authenticator app').fill(currentTotp(u));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toBeHidden();
}

test('[Q7][Q8] an IT Admin prepares the export, keeps its passphrase, downloads it and opens it', async ({ browser, viewport }) => {
  // The worker prepares it on its own pass. The demo institution's export is every test run's records and documents
  // (65 MB and 825 files on 2026-11-15, about 90 s on a loaded laptop).
  test.setTimeout(360_000);
  const { page, u } = await signedIn(browser, viewport);
  const shots = process.env.E2E_SHOTS;
  const project = test.info().project.name;

  await navTo(page, 'Data export');
  await expect(page.getByRole('heading', { level: 1, name: 'Data export' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm it’s me' }).click();
  await confirmItsMe(page, u);
  await expect(page.getByRole('heading', { name: 'Prepare an export' })).toBeVisible();
  await expect(page.getByText('None yet. When you prepare one, it shows here.')).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);

  // The passphrase, once: six groups of five; Done waits for the promise to keep it.
  await page.getByRole('button', { name: 'Prepare an export' }).click();
  await expect(page.getByRole('heading', { name: 'Keep this passphrase' })).toBeFocused();
  const groups = await page.getByRole('list', { name: 'Passphrase, in six groups' }).getByRole('listitem').allTextContents();
  expect(groups).toHaveLength(6);
  const passphrase = groups.join('-');
  expect(passphrase).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
  const done = page.getByRole('button', { name: 'Done' });
  await expect(done).toBeDisabled();
  expect(await seriousA11y(page)).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/export-passphrase-${project}.png`, fullPage: true });
  await page.getByLabel(/I’ve kept the passphrase somewhere safe/).check();
  await done.click();

  // Prepared by the worker; the list refreshes itself. It's never shown again.
  const row = page.getByRole('list', { name: 'Exports' }).getByRole('listitem').first();
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByText(passphrase)).toHaveCount(0);
  await expect(row.getByText(/records in \d+ tables/)).toBeVisible();
  await expect(page.getByText(/You can ask for the next one from/)).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);
  if (shots) await page.screenshot({ path: `${shots}/export-ready-${project}.png`, fullPage: true });

  // The download: an encrypted ZIP of this institution, opened with the passphrase.
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: 'Download' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^demo-uni-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const path = await download.path();
  const bytes = new Uint8Array(readFileSync(path));
  const opened = await openExport(bytes, passphrase);
  expect(opened.manifest.institution.slug).toBe('demo-uni');
  expect(opened.names).toEqual(expect.arrayContaining(['manifest.json', 'README.txt', 'tables/user_account.jsonl', 'tables/audit_event.jsonl']));
  expect(opened.manifest.tables.find((t) => t.name === 'user_account')?.rows).toBeGreaterThan(0);
  await expect(openExport(bytes, 'WRONG-WRONG-WRONG-WRONG-WRONG-WRONG')).rejects.toThrow();
  await page.context().close();
});

test('[Q1] the page and its link are for IT Admins only', async ({ browser, viewport }) => {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), extraHTTPHeaders: { 'x-forwarded-for': randomClientIp() } });
  const page = await context.newPage();
  const u = await makeUser('demo-uni', { role: 'LECTURER' });
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  // Nowhere in the navigation, the phone's bar included (a lecturer's few pages need no "More").
  await expect(page.getByRole('link', { name: 'Data export' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More' })).toHaveCount(0);
  const res = await page.goto(`${DEMO}/workspace/export`);
  expect(res?.status()).toBe(404);
  await context.close();
});
