// Spec 0028 PR B: what the console's journeys need outside the browser. Members are made through the console's own
// database role (.env.console, from `pnpm db:setup`), with an address of their own per run (console-e2e-…@staff.test,
// retired by global-teardown.ts); codes come from Mailpit, sent by the platform API's own relay; TOTP and hashing are
// the API's own functions (plain source, no decorators), so they match the server exactly.
import { expect, type Page } from '@playwright/test';
import { createPlatformClient } from '@univarse/db';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { expectAccessible } from './a11y';
import { hashPassword } from '../../api/src/modules/identity/password.js';
import { base32Decode, hotp, timeStep } from '../../api/src/modules/identity/totp.js';

export const consoleEnv = () =>
  parseEnv(readFileSync(new URL('../../../.env.console', import.meta.url), 'utf8')) as Record<string, string | undefined>;

/** Every member a run makes starts with this, so the teardown retires exactly those. */
export const E2E_PREFIX = 'console-e2e-';
/** Random per run: no credential literal in the repo (gitleaks), and still meets the password policy. */
export const PASSWORD = `E2e-${randomBytes(12).toString('base64url')}-7a`;

export const uniqueEmail = (tag: string) => `${E2E_PREFIX}${tag}-${randomBytes(4).toString('hex')}@staff.test`;

/** A member with a password and no authenticator yet: what the owner's command and an activation leave behind. */
export async function makeMember(role: 'OWNER' | 'SUPPORT' | 'READ_ONLY'): Promise<{ email: string }> {
  const db = createPlatformClient(consoleEnv().CONSOLE_DATABASE_URL!);
  try {
    const email = uniqueEmail(role.toLowerCase());
    await db.platformUser.create({ data: { email, emailVerifiedAt: new Date(), displayName: `Ada E2E ${role}`, role, passwordHash: await hashPassword(PASSWORD) } });
    return { email };
  } finally {
    await db.$disconnect();
  }
}

/** Every institution a run makes has this prefix, so the teardown removes exactly those. */
export const E2E_TENANT_PREFIX = 'e2e-reg-';

const migratorUrl = () => (parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')) as Record<string, string | undefined>).PLATFORM_MIGRATOR_URL!;

/** A live institution with one product on. Made by the migrator: the console role can't create one (spec 0033 Q15). */
export async function makeInstitution(): Promise<{ id: string; slug: string; legalName: string }> {
  const db = createPlatformClient(migratorUrl());
  try {
    const tag = randomBytes(4).toString('hex');
    const shard = await db.shard.findFirstOrThrow({ select: { id: true } });
    const t = await db.tenant.create({
      data: { slug: `${E2E_TENANT_PREFIX}${tag}`, legalName: `E2E University ${tag}`, shortName: `E2E${tag}`.toUpperCase(), type: 'UNIVERSITY', ownership: 'PRIVATE', status: 'ACTIVE', shardId: shard.id },
      select: { id: true, slug: true, legalName: true },
    });
    await db.tenantProduct.create({ data: { tenantId: t.id, product: 'admissions', entitled: true, enabled: true } });
    return t;
  } finally {
    await db.$disconnect();
  }
}

/** A TOTP code `offset` steps from now: each use of a factor needs a newer step than the last (the replay guard). */
export const totp = (secret: string, offset = 0) => hotp(base32Decode(secret), timeStep(Date.now()) + offset);

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025';

/** The newest 6-digit code emailed to `to` after `since`, from Mailpit. Polls for up to 20 s. */
export async function emailedCode(to: string, since: Date): Promise<string> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const list = (await res.json()) as { messages: { ID: string; Created: string }[] };
    const fresh = list.messages.find((m) => new Date(m.Created).getTime() >= since.getTime() - 1000);
    if (fresh) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${fresh.ID}`)).json()) as { Text: string };
      const m = /\b(\d{6})\b/.exec(msg.Text);
      if (m?.[1]) return m[1];
    }
    if (Date.now() > deadline) throw new Error('No code was emailed within 20 s');
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The status the platform API gives this browser's own cookies, asked from the page (same origin, as the app asks). */
export const apiStatus = (page: Page, path: string) =>
  page.evaluate(async (p) => (await fetch(`/api/platform/v1${p}`, { cache: 'no-store' })).status, path);

/**
 * The setup page from an enrolment session: the key typed instead of scanned, the current code (so the next step is
 * still unused, whichever side of a step's end the server sees it), the codes shown once, and the acknowledgement.
 * Returns the secret and the recovery codes.
 */
export async function enrol(page: Page): Promise<{ secret: string; codes: string[] }> {
  await expect(page.getByRole('heading', { level: 1, name: 'Set up your authenticator app' })).toBeVisible();
  await expect(page.locator('.pc-qr svg')).toBeVisible();
  await expectAccessible(page);
  await page.getByText('Can’t scan? Type this key instead').click();
  const secret = (await page.locator('.pc-secret').innerText()).replace(/^Setup key:/, '').replace(/[^A-Z2-7]/g, '');
  expect(secret.length).toBeGreaterThanOrEqual(16);
  await page.getByRole('button', { name: 'I’ve added it' }).click();
  await page.getByLabel('6-digit code').fill(totp(secret)); // six digits submit by themselves
  await expect(page.getByRole('heading', { level: 1, name: 'Save your recovery codes' })).toBeVisible();
  const codes = await page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem').allInnerTexts();
  expect(codes).toHaveLength(10);
  const go = page.getByRole('button', { name: 'Go to the console' });
  await expect(go).toBeDisabled();
  await expectAccessible(page);
  await page.getByLabel('I’ve saved these codes somewhere safe.').check();
  await go.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Platform console' })).toBeVisible();
  return { secret, codes };
}
