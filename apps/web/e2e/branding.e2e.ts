/**
 * Spec 0033 Q11, Q12 (PR C): an institution's colour and logo on its own sign-in page and workspace, and never on
 * another's; the colour's text pair passes axe. Branding is written as the migrator, which only the dev chain holds:
 * on the stack run this file is skipped, and criterion 14 (the owner's check) covers the stack.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { createPlatformClient, type PlatformClient } from '@univarse/db';
import { expect, test, type Page } from '@playwright/test';
import { animationsSettled, cleanup, E2E, hostUrl, makeUser, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');
const POLY = hostUrl('test-poly');
const COLOR = '#0B3D91'; // dark: the domain pairs it with white
const COLOR_RGB = 'rgb(11, 61, 145)';

/** A real, decodable 96×48 PNG of one colour, so the browser renders it (naturalWidth > 0). */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const LOGO = solidPng(96, 48, [11, 61, 145]);
const LOGO_SHA = createHash('sha256').update(LOGO).digest('hex');

let migrator: PlatformClient | undefined;
let polyId: string;
let before: { primaryColor: string | null; logo: Uint8Array | null; logoMime: string | null; logoSha256: string | null } | null = null;

test.skip(E2E.stack, 'branding is written as the migrator, which the stack run does not hold');

test.beforeAll(async ({ request }) => {
  const env = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>;
  migrator = createPlatformClient(env.PLATFORM_MIGRATOR_URL!);
  polyId = (await migrator.tenant.findUniqueOrThrow({ where: { slug: 'test-poly' }, select: { id: true } })).id;
  before = await migrator.tenantBranding.findUnique({ where: { tenantId: polyId }, select: { primaryColor: true, logo: true, logoMime: true, logoSha256: true } });
  const data = { primaryColor: COLOR, logo: new Uint8Array(LOGO), logoMime: 'image/png', logoSha256: LOGO_SHA, updatedAt: new Date() };
  await migrator.tenantBranding.upsert({ where: { tenantId: polyId }, create: { tenantId: polyId, ...data }, update: data, select: { tenantId: true } });
  // The capture reaches the API through the worker's relay; wait until this host serves it.
  // Node doesn't resolve *.localhost everywhere (the browser does): ask the edge on loopback, with the host's name.
  const edge = new URL(POLY);
  const host = edge.host;
  edge.hostname = '127.0.0.1';
  const served = async () => {
    const res = await request.get(new URL('/api/v1/tenant/public-profile', edge).href, { headers: { host } });
    return ((await res.json()) as { branding: { logoSha256: string | null } }).branding.logoSha256;
  };
  await expect.poll(served, { timeout: 20_000 }).toBe(LOGO_SHA);
});

test.afterAll(async () => {
  if (migrator) {
    if (before) await migrator.tenantBranding.update({ where: { tenantId: polyId }, data: { ...before, logo: before.logo ? new Uint8Array(before.logo) : null, updatedAt: new Date() }, select: { tenantId: true } });
    else await migrator.tenantBranding.deleteMany({ where: { tenantId: polyId } });
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

const logoRendered = (page: Page, selector: string) =>
  page.locator(selector).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);

test('[BR4] the sign-in page carries the institution’s logo and colour, and passes axe', async ({ page }) => {
  await page.goto(`${POLY}/login`);
  const logo = page.locator('img.auth__logo');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', `/api/v1/tenant/logo?v=${LOGO_SHA}`);
  await expect(logo).toHaveAttribute('alt', ''); // the institution's name is the text right beside it
  await expect.poll(() => logoRendered(page, 'img.auth__logo')).toBe(true);
  const button = page.getByRole('button', { name: 'Sign in' });
  await expect(button).toHaveCSS('background-color', COLOR_RGB);
  await expect(button).toHaveCSS('color', 'rgb(255, 255, 255)');
  expect(await seriousA11yViolations(page)).toEqual([]);
});

test('[BR4] another institution’s sign-in page has neither', async ({ page }) => {
  await page.goto(`${DEMO}/login`);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('img.auth__logo')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sign in' })).not.toHaveCSS('background-color', COLOR_RGB);
});

test('[BR5] the workspace rail carries the logo, and on a wide screen the colour; it passes axe', async ({ page }) => {
  const u = await makeUser('test-poly', { role: 'LECTURER' });
  await page.goto(`${POLY}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${POLY}/workspace`);
  // The rail on a wide screen, the top bar on a phone: one logo is shown either way.
  const wide = (page.viewportSize()?.width ?? 0) >= 900;
  const where = wide ? '.ws__rail img.ws__logo' : '.ws__top img.ws__logo';
  await expect(page.locator(where)).toBeVisible();
  await expect(page.locator(where)).toHaveAttribute('alt', '');
  await expect.poll(() => logoRendered(page, where)).toBe(true);
  if (wide) await expect(page.locator('.ws__rail')).toHaveCSS('background-color', COLOR_RGB);
  expect(await seriousA11yViolations(page)).toEqual([]);
});
