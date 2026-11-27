/**
 * Spec 0042 (P2-S1 PR B): the Structure page through edge → web → API → DB. The Registrar builds a small part of the
 * tree, edits it, moves a unit (by drag-and-drop on desktop, by "Move unit" on a phone; both confirm first), reads
 * the tree as it was, archives what it made, and looks at the unit types. A lecturer sees the tree and changes
 * nothing. axe on the chart, the panel and its forms. Runs on desktop and mobile.
 */
import AxeBuilder from '@axe-core/playwright';
import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { animationsSettled, cleanup, clearReplayGuardFor, currentTotp, hostUrl, makeUser, navTo, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');

test.afterAll(async () => {
  await cleanup();
});

async function seriousA11y(page: Page) {
  await animationsSettled(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

type User = Awaited<ReturnType<typeof makeUser>>;

async function signedIn(browser: Browser, role: string, viewport: { width: number; height: number } | null, mfa = true): Promise<{ page: Page; u: User }> {
  const context = await browser.newContext({ ...(viewport ? { viewport } : {}), extraHTTPHeaders: { 'x-forwarded-for': randomClientIp() } });
  const page = await context.newPage();
  const u = await makeUser('demo-uni', { role, mfa });
  await page.goto(`${DEMO}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(u.username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (mfa) {
    await expect(page).toHaveURL(`${DEMO}/login/verify`);
    await page.getByLabel('6-digit code').fill(currentTotp(u));
  }
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

const daysAgo = (n: number) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
};

test('[P2-S1] the Registrar builds, moves, reads as at a day and archives part of the tree', async ({ browser, viewport }, info) => {
  test.setTimeout(300_000); // a step-up, a dozen writes, axe five times, on a busy machine
  const phone = info.project.name === 'mobile';
  const tag = randomBytes(2).toString('hex').toUpperCase();
  const facultyName = `E2E Faculty ${tag}`;
  const deptName = `E2E Department ${tag}`;
  const { page, u } = await signedIn(browser, 'REGISTRAR', viewport);
  await navTo(page, 'Structure');
  await expect(page).toHaveTitle('Structure · UniVarse');

  const chart = page.getByRole('region', { name: 'Organisation chart' });
  const panel = page.getByRole('complementary', { name: 'The chosen unit' });
  await expect(chart.getByRole('button', { name: /^Demo University/ })).toBeVisible();
  await expect(chart.getByRole('button', { name: /^Faculty of Science/ })).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);

  // A faculty of the test's own under the institution, founded 10 days ago.
  await page.getByRole('button', { name: 'Add a unit', exact: true }).click();
  await expect(panel.getByRole('heading', { name: /Add a unit to Demo University/ })).toBeVisible();
  await panel.getByLabel('Type').selectOption({ label: 'Faculty' });
  await panel.getByLabel('Name').fill(facultyName);
  await panel.getByLabel('Code').fill(`f${tag}`);
  await panel.getByLabel('Takes effect').fill(daysAgo(10));
  expect(await seriousA11y(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Add the unit' }).click();
  await expect(panel.getByText(`${facultyName} was added to Demo University`)).toBeVisible();
  await expect(panel.getByRole('heading', { name: facultyName, level: 2 })).toBeVisible();
  await expect(panel.getByText(`F${tag}`, { exact: true })).toBeVisible(); // the code, upper-cased

  // A department under the Faculty of Science, from its own panel.
  if (phone) await panel.getByRole('button', { name: 'Back to the structure' }).click();
  await chart.getByRole('button', { name: /^Faculty of Science/ }).click();
  await panel.getByRole('button', { name: 'Add a unit inside' }).click();
  await panel.getByLabel('Name').fill(deptName);
  await panel.getByRole('button', { name: 'Add the unit' }).click();
  await expect(panel.getByText(`${deptName} was added to Faculty of Science`)).toBeVisible();

  // Edit: a new name, kept in its history.
  await panel.getByRole('button', { name: 'Edit details' }).click();
  await panel.getByLabel('Name').fill(`${deptName} (renamed)`);
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved.')).toBeVisible();
  await expect(panel.getByText('Renamed: now')).toBeVisible();

  // The move: by dropping it onto the new faculty on desktop, by "Move unit" on a phone. Either way it only opens the
  // form, which says what moves; nothing has moved yet.
  if (phone) {
    await panel.getByRole('button', { name: 'Move unit' }).click();
  } else {
    await chart.getByRole('button', { name: new RegExp(`^${deptName}`) }).dragTo(chart.getByRole('button', { name: new RegExp(`^${facultyName}`) }));
  }
  await expect(panel.getByRole('heading', { name: `Move ${deptName} (renamed)` })).toBeVisible();
  if (phone) await panel.getByRole('radio', { name: new RegExp(facultyName) }).check();
  await expect(panel.getByRole('radio', { name: new RegExp(facultyName) })).toBeChecked();
  await expect(panel.getByText('Anyone whose role is given on Faculty of Science stops covering it once it moves.')).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);
  await panel.getByLabel('Why it’s moving').fill('Computing gets its own faculty');
  await panel.getByRole('button', { name: `Move it under ${facultyName}` }).click();
  await confirmItsMe(page, u);
  await expect(panel.getByText(`now sits under ${facultyName}`)).toBeVisible();
  await expect(panel.getByText('“Computing gets its own faculty”')).toBeVisible();

  // As at 5 days ago: the faculty was there (founded 10 days ago); the department wasn't (made today). On a phone
  // the toolbar steps aside while a unit is open: back to the structure first.
  if (phone) await panel.getByRole('button', { name: 'Back to the structure' }).click();
  await page.getByLabel('As at').fill(daysAgo(5));
  await expect(page.getByText(/The structure as it was at the end of/)).toBeVisible();
  await expect(chart.getByRole('button', { name: new RegExp(`^${facultyName}`) })).toBeVisible();
  await expect(chart.getByRole('button', { name: new RegExp(`^${deptName}`) })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a unit', exact: true })).toHaveCount(0); // nothing changes in the past
  await page.getByRole('button', { name: 'Back to today' }).click();
  await expect(page.getByText(/The structure as it was/)).toHaveCount(0);

  // Search finds by code, and the path to it stays.
  await page.getByLabel('Find a unit').fill(`f${tag}`);
  await expect(chart.getByRole('button', { name: new RegExp(`^${facultyName}`) })).toBeVisible();
  await expect(chart.getByRole('button', { name: /^Registry/ })).toHaveCount(0);
  // A search that finds nothing says so, and the chart comes back when it's cleared.
  await page.getByLabel('Find a unit').fill(`zz${tag}nothing`);
  await expect(page.getByText(`No unit’s name or code holds “zz${tag}nothing”.`)).toBeVisible();
  await page.getByLabel('Find a unit').fill('');
  await expect(chart.getByRole('button', { name: /^Registry/ })).toBeVisible();

  // Archive: leaf first. The faculty refuses while its department is open, then goes once the department has.
  await chart.getByRole('button', { name: new RegExp(`^${facultyName}`) }).click();
  await panel.getByRole('button', { name: 'Archive' }).click();
  await expect(panel.getByText('Archive the 1 unit inside it first')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Archive it' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  if (phone) await panel.getByRole('button', { name: 'Back to the structure' }).click();
  await chart.getByRole('button', { name: new RegExp(`^${deptName}`) }).click();
  await panel.getByRole('button', { name: 'Archive' }).click();
  await panel.getByLabel('Why it’s being archived').fill('End of the test');
  await panel.getByRole('button', { name: 'Archive it' }).click();
  await expect(panel.getByText(`${deptName} (renamed) is archived.`)).toBeVisible();
  if (phone) await panel.getByRole('button', { name: 'Back to the structure' }).click();
  await chart.getByRole('button', { name: new RegExp(`^${facultyName}`) }).click();
  await panel.getByRole('button', { name: 'Archive' }).click();
  await panel.getByLabel('Why it’s being archived').fill('End of the test');
  await panel.getByRole('button', { name: 'Archive it' }).click();
  await expect(panel.getByText(`${facultyName} is archived.`)).toBeVisible();
  if (phone) await panel.getByRole('button', { name: 'Back to the structure' }).click();
  await expect(chart.getByRole('button', { name: new RegExp(`^${facultyName}`) })).toHaveCount(0);
  if (!phone) await panel.getByRole('heading', { level: 2 }).waitFor(); // the panel stays beside the chart on desktop
  await page.getByRole('switch', { name: 'Show archived' }).click();
  await expect(chart.getByRole('button', { name: new RegExp(`^${facultyName}`) })).toBeVisible();
  expect(await seriousA11y(page)).toEqual([]);

  // The unit types: read, the editor opens and closes (the demo institution's types stay as they are).
  await page.getByRole('link', { name: 'Edit unit types' }).click();
  await expect(page).toHaveTitle('Unit types · UniVarse');
  await page.getByRole('button', { name: 'Edit Faculty' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Faculty' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Department', exact: true })).toBeChecked();
  expect(await seriousA11y(page)).toEqual([]);
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('[P2-S1] a lecturer sees the structure and changes nothing', async ({ browser, viewport }) => {
  const { page } = await signedIn(browser, 'LECTURER', viewport, false);
  await navTo(page, 'Structure');
  await expect(page.getByRole('link', { name: 'Unit types' })).toBeVisible();
  const chart = page.getByRole('region', { name: 'Organisation chart' });
  await chart.getByRole('button', { name: /^Faculty of Science/ }).click();
  const panel = page.getByRole('complementary', { name: 'The chosen unit' });
  await expect(panel.getByRole('heading', { name: 'Faculty of Science', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a unit', exact: true })).toHaveCount(0);
  for (const action of ['Edit details', 'Add a unit inside', 'Move unit', 'Archive', 'Deactivate']) await expect(panel.getByRole('button', { name: action })).toHaveCount(0);
  expect(await seriousA11y(page)).toEqual([]);
});
