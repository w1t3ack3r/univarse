// Spec 0031 PR B: seeing what happened, through a real browser, the dev edge, the platform API and its database. The
// log, its check, the security page and the access review, for each role that differs. The owner's journey is one test in
// one browser, because a TOTP step works once. The development database is shared, so a month already attested shows as done, and the security
// page's full view uses a set response: the console role can't remove what a test would write there.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './a11y';
import { enrol, makeMember, PASSWORD, randomClientIp, totp } from './fixtures';

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Console' });

async function signInNew(page: Page, role: 'OWNER' | 'SUPPORT' | 'READ_ONLY'): Promise<{ email: string; secret: string }> {
  const { email } = await makeMember(role);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  const { secret } = await enrol(page);
  return { email, secret };
}

test('an OWNER reads the log, checks the chain, reads security and attests the review', async ({ page }) => {
  const owner = await signInNew(page, 'OWNER');

  await test.step('the log', async () => {
  await tabs(page).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  const log = page.getByRole('list', { name: 'Audit entries, newest first' });
  await expect(log.getByText('Set up their authenticator').first()).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('What').selectOption('platform.mfa');
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  await expect(log.getByText('Set up their authenticator').first()).toBeVisible();
  await expect(log.getByText('Signed in', { exact: true })).toHaveCount(0);

  await log.getByText('Set up their authenticator').first().click();
  await expect(log.getByText('platform.mfa.enrolled').first()).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.locator('.pc-chain .pc-status')).toHaveText('Intact', { timeout: 60_000 });
  await expect(page.locator('.pc-chain__meta')).toContainText('Nothing has been changed or removed');
  });

  await test.step('a broken chain shows on every page', async () => {
  await page.route('**/api/platform/v1/audit/verification', (route) => route.fulfill({ json: { latest: null, recent: [], broken: true } }));
  await page.goto('/account');
  const banner = page.getByRole('alert').filter({ hasText: 'The audit log failed its last check.' });
  await expect(banner).toBeVisible();
  await expectAccessible(page);
  await banner.getByRole('link', { name: 'See the audit log' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await page.unroute('**/api/platform/v1/audit/verification');
  });

  await test.step('the security page answers from the real rollups, and reads whole with events in it', async () => {
  await tabs(page).getByRole('link', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await expect(page.locator('.pc-section__lead')).not.toHaveText(/never who/); // the answer arrived
  await page.getByRole('button', { name: '7 days' }).click();
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');

  const now = Date.now();
  const hour = (back: number) => new Date(Math.floor(now / 3_600_000) * 3_600_000 - back * 3_600_000).toISOString();
  await page.route('**/api/platform/v1/security?*', (route) =>
    route.fulfill({
      json: {
        window: '24h',
        totals: { act: 1, watch: 14, note: 40 },
        events: [
          { event: 'db.rls_violation', level: 'act', count: 1, lastSeenAt: hour(1) },
          { event: 'auth.account.locked', level: 'watch', count: 14, lastSeenAt: hour(2) },
          { event: 'auth.rate_limited', level: 'note', count: 40, lastSeenAt: hour(0) },
          { event: 'future.event', level: 'watch', count: 1, lastSeenAt: hour(0) },
        ],
        institutions: [{ institution: { id: '019a0000-0000-7000-8000-000000000001', slug: 'demo-uni', name: 'Demo University' }, act: 1, watch: 14, note: 40 }],
        series: [
          { at: hour(1), act: 1, watch: 2, note: 5 },
          { at: hour(2), act: 0, watch: 12, note: 15 },
          { at: hour(6), act: 0, watch: 0, note: 20 },
        ],
      },
    }),
  );
  await page.getByRole('button', { name: 'Last 24 hours' }).click();
  await expect(page.locator('.pc-section__lead')).toHaveText('1 event needs someone to look at it.');
  await expect(page.getByText('The database refused a request')).toBeVisible();
  await expect(page.getByText('future.event')).toBeVisible(); // no words for it yet: still shown
  await expect(page.getByRole('cell', { name: 'Demo University' })).toBeVisible();
  await page.getByText('See these as a table').click();
  await expect(page.locator('.pc-disclosure__body tbody tr')).toHaveCount(3);
  await expectAccessible(page);
  await page.unroute('**/api/platform/v1/security?*');
  });

  await test.step('the month’s review: attested with a step-up, or already done', async () => {
  await tabs(page).getByRole('link', { name: 'Access review' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Access review: / })).toBeVisible();
  await expect(page.locator('.pc-section__head .pc-status')).toBeVisible();
  await expect(page.locator('.pc-skeleton')).toHaveCount(0);
  if ((await page.locator('.pc-section__head .pc-status').innerText()) === 'Done') return; // this database's month is attested

  await tabs(page).getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('link', { name: /^Access review/ }).last()).toContainText(/Due|Overdue/);
  await tabs(page).getByRole('link', { name: 'Access review' }).click();

  const attest = page.getByRole('button', { name: 'Attest this review' });
  await expect(attest).toBeDisabled();
  await expect(page.getByText(/still to mark/)).toBeVisible();
  await expectAccessible(page);

  const you = page.getByRole('listitem').filter({ hasText: '(you)' });
  await you.getByLabel('Needs a change').check({ force: true });
  await you.getByLabel('What needs to change? (optional)').fill('Tested by the journey');
  await expectAccessible(page);
  for (const keep of await page.getByLabel('Keep').all()) {
    const name = await keep.getAttribute('name');
    if ((await page.locator(`input[name="${name ?? ''}"]:checked`).count()) === 0) await keep.check({ force: true });
  }
  await expect(attest).toBeEnabled();
  await attest.click();

  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Code from your authenticator app').fill(totp(owner.secret, 1));
  await expect(dialog).toBeHidden();
  await expect(page.getByText('This month’s review is attested and recorded.')).toBeVisible();
  await expect(page.locator('.pc-section__head .pc-status')).toHaveText('Done');
  await expect(page.getByRole('heading', { name: 'Past reviews' })).toBeVisible();
  await expectAccessible(page);
  await tabs(page).getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toBeVisible();
  await expect(page.locator('.pc-list .pc-status')).toHaveCount(0); // done: nothing asks for attention
  });
});

test('READ_ONLY reads all three and can start and attest nothing', async ({ page }) => {
  await signInNew(page, 'READ_ONLY');
  await tabs(page).getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Audit entries, newest first' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check now' })).toHaveCount(0);
  await tabs(page).getByRole('link', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  await tabs(page).getByRole('link', { name: 'Access review' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Access review/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attest this review' })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
});

test('SUPPORT has none of the three: no tabs, and the addresses show nothing', async ({ page }) => {
  await signInNew(page, 'SUPPORT');
  for (const name of ['Audit log', 'Security', 'Access review']) await expect(tabs(page).getByRole('link', { name })).toHaveCount(0);
  for (const path of ['/audit', '/security', '/access-review']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: /^(Audit log|Security|Access review)/ })).toHaveCount(0);
  }
});
