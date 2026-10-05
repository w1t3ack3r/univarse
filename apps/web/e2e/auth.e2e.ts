/**
 * Spec 0005 PR A — sign-in journeys through the real edge → web → API → DB (W10), plus axe (W9)
 * and security headers (W8). Runs on desktop and mobile projects (playwright.config.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, clearReplayGuard, currentTotp, hostUrl, makeUser, PASSWORD, randomClientIp } from './fixtures';

const DEMO = hostUrl('demo-uni');
const POLY = hostUrl('test-poly');

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': randomClientIp() });
});

test.afterAll(async () => {
  await cleanup();
});

async function signIn(page: Page, base: string, username: string, password = PASSWORD): Promise<void> {
  await page.goto(`${base}/login`);
  await page.getByLabel('Matric number, staff number or email').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Our problem alert. Next.js also renders a role="alert" route announcer, so filter by our class. */
const problemAlert = (page: Page) => page.locator('.uv-notice[role="alert"]');

async function seriousA11yViolations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.help}`);
}

test('[W10][W6][W7] login → workspace with permission-driven nav → logout', async ({ page }) => {
  // REGISTRAR holds identity.user.view, and audit.event.view (privileged), so MFA is part of the journey.
  const u = await makeUser('demo-uni', { role: 'REGISTRAR', mfa: true });
  await clearReplayGuard('demo-uni', u);
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await page.getByLabel('6-digit code').fill(currentTotp(u));
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Ada'); // "Good morning, Ada"
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await nav.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${DEMO}/login`);
  await page.goto(`${DEMO}/workspace`);
  await expect(page).toHaveURL(`${DEMO}/login`); // W7: no session, no workspace
});

test('[W6] a user without the permission does not see the gated item', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'LECTURER' });
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Users' })).toHaveCount(0);
});

test('[W10][W5] login with an authenticator code; a wrong code gets the generic error', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT', mfa: true });
  await clearReplayGuard('demo-uni', u);
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await page.getByLabel('6-digit code').fill('000000');
  await expect(problemAlert(page)).toContainText('not right');
  await page.getByLabel('6-digit code').fill(currentTotp(u));
  await expect(page).toHaveURL(`${DEMO}/workspace`);
});

test('[W10][W5] login with a recovery code, which then works only once', async ({ page, context }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT', recoveryCode: true });
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code').fill(u.recoveryCode!.toLowerCase()); // case and dash don't matter
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(`${DEMO}/workspace`);

  await context.clearCookies();
  await signIn(page, DEMO, u.username);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByLabel('Recovery code').fill(u.recoveryCode!);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(problemAlert(page)).toContainText('not right');
});

test('[W10][W4] a wrong password shows the error with a support reference', async ({ page }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await signIn(page, DEMO, u.username, 'Not-The-Password-1');
  const alert = problemAlert(page);
  await expect(alert).toContainText('That username or password is not right.');
  await expect(alert).toContainText(/Support reference: \S+/);
  await expect(page).toHaveURL(`${DEMO}/login`);
});

test('[W10] a session from one institution is not accepted on another', async ({ page, context }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  const sid = (await context.cookies(DEMO)).find((c) => c.name === '__Host-uv_sid');
  expect(sid).toBeDefined();
  // Replay the stolen value to another institution's host as a raw header: browsers refuse to plant a
  // __Host- cookie for another domain, which is the point of the prefix; an attacker would send it directly.
  await page.setExtraHTTPHeaders({ cookie: `__Host-uv_sid=${sid!.value}` });
  await page.goto(`${POLY}/workspace`);
  await expect(page).toHaveURL(`${POLY}/login`);
});

test('[W2] the session cookie is HttpOnly and nothing is kept in web storage', async ({ page, context }) => {
  const u = await makeUser('demo-uni', { role: 'STUDENT' });
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  const sid = (await context.cookies(DEMO)).find((c) => c.name === '__Host-uv_sid');
  expect(sid?.httpOnly).toBe(true);
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    readable: document.cookie,
  }));
  expect(stored).toEqual({ local: [], session: [], readable: '' });
});

test('[W8] pages carry the nonce CSP and security headers, with no CSP violations', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  const res = await page.goto(`${DEMO}/login`);
  const h = res!.headers();
  expect(h['content-security-policy']).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-content-type-options']).toBe('nosniff');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  expect(violations).toEqual([]);
});

test('[W9] no serious or critical accessibility violations on login, MFA verify and the workspace', async ({ page }) => {
  test.slow(); // three full axe scans plus a sign-in: ~45 s on slow machines (mobile project)
  // Wait for each page's own <title> before scanning: after a client-side navigation the URL changes
  // a moment before Next sets the title, and a scan in that gap reports "document-title" (seen once in CI).
  await page.goto(`${DEMO}/login`);
  await expect(page).toHaveTitle('Sign in · UniVarse');
  expect(await seriousA11yViolations(page)).toEqual([]);
  const u = await makeUser('demo-uni', { role: 'STUDENT', mfa: true });
  await clearReplayGuard('demo-uni', u);
  await signIn(page, DEMO, u.username);
  await expect(page).toHaveURL(`${DEMO}/login/verify`);
  await expect(page).toHaveTitle('Confirm it’s you · UniVarse');
  expect(await seriousA11yViolations(page)).toEqual([]);
  await page.getByLabel('6-digit code').fill(currentTotp(u));
  await expect(page).toHaveURL(`${DEMO}/workspace`);
  await expect(page).toHaveTitle('Home · UniVarse');
  expect(await seriousA11yViolations(page)).toEqual([]);
});
