import { defineConfig, devices } from '@playwright/test';

// Spec 0005 W10: the real chain — edge (:4180) → web (production build, :3000) → API (:8099) → DB.
// Run `pnpm build` first: the API serves from dist and `next start` serves .next.
// Locally, already-running servers are reused.
const reuse = !process.env.CI;
// Optional installed browser instead of Playwright's download, e.g. PW_CHANNEL=msedge locally.
const channel = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
const repo = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  globalSetup: './e2e/global-setup.ts', // starts the outbox worker so emailed codes reach Mailpit
  fullyParallel: false, // TOTP replay guard and rate limits are per user/IP; keep journeys sequential
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, ...channel } },
  ],
  webServer: [
    {
      command: 'node tools/dev-edge/start-api.mjs',
      cwd: repo,
      url: 'http://127.0.0.1:8099/health/live',
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @univarse/web start',
      cwd: repo,
      url: 'http://127.0.0.1:3000/login',
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      command: 'node tools/dev-edge/server.mjs',
      cwd: repo,
      port: 4180,
      reuseExistingServer: reuse,
      timeout: 30_000,
    },
  ],
});
