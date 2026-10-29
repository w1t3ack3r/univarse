import { defineConfig, devices } from '@playwright/test';

// Spec 0027 P6: the console's frame, served by `next start` (run `pnpm --filter @univarse/console build` first). PR B
// adds the run through the stack's edge, with the allowlist; S2 adds the sign-in journeys.
const channel = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
const repo = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:3001', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, ...channel } },
  ],
  webServer: {
    command: 'pnpm --filter @univarse/console start',
    cwd: repo,
    url: 'http://127.0.0.1:3001/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
