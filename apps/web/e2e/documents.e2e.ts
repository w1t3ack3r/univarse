/**
 * Spec 0010 FU9 — "My documents" through edge → web → API → SeaweedFS (presigned POST) → worker →
 * ClamAV, on desktop and mobile. The test marker is assembled at run time; nothing in the repo holds it.
 */
import { createHash, randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, hostUrl, makeUser, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');
const MARKER = ['UNIVARSE', 'CLAMAV', 'TEST', 'MARKER', '7d41c2e9a05b'].join('-');

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});
test.afterAll(async () => {
  await cleanup();
});

async function seriousA11y(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdf = (tag: string) => Buffer.from(`%PDF-1.4\n% ${tag} ${randomBytes(8).toString('hex')}\n%%EOF\n`);

test('[FU9] upload → checking → ready → download (exact bytes) → delete; a ClamAV detection is blocked', async ({ page }, info) => {
  test.slow(); // real scanning in the loop
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${DEMO}/workspace`);

  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Documents' }).click();
  await expect(page).toHaveTitle('My documents · UniVarse');
  await expect(page.getByText('No documents yet.')).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);

  // A wrong type is refused in the browser before anything is sent.
  await page.locator('#doc-file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText('Only PDF, PNG or JPEG files can be uploaded.')).toBeVisible();

  // A clean PDF: checking, then ready.
  const bytes = pdf('e2e clean');
  const name = `Result slip ${randomBytes(2).toString('hex')}.pdf`;
  await page.locator('#doc-file').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 30_000 });
  expect(await seriousA11y(page)).toEqual([]);

  // Download returns exactly the uploaded bytes.
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: `Download ${name}` }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  const chunks: Buffer[] = [];
  for await (const c of (await download.createReadStream()) as AsyncIterable<Buffer>) chunks.push(c);
  expect(sha(Buffer.concat(chunks))).toBe(sha(bytes));

  // A PDF ClamAV detects (test signature): blocked, never downloadable.
  const bad = `Scan ${randomBytes(2).toString('hex')}.pdf`;
  await page.locator('#doc-file').setInputFiles({ name: bad, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${MARKER}\n%%EOF\n`) });
  const badRow = page.getByRole('listitem').filter({ hasText: bad });
  await expect(badRow.getByText('Blocked')).toBeVisible({ timeout: 30_000 });
  await expect(badRow.getByRole('link', { name: /Download/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('documents.png'), fullPage: true });

  // Delete, confirmed inline.
  await row.getByRole('button', { name: `Delete ${name}` }).click();
  await row.getByRole('button', { name: 'Yes, delete' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);
  expect(await seriousA11y(page)).toEqual([]);
});
