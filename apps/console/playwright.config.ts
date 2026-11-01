import { defineConfig, devices } from '@playwright/test';

// Spec 0027 P6: the console's frame, served by `next start` (run `pnpm --filter @univarse/console build` first). With
// E2E_CONSOLE_IMAGE set (CI's image job, the release), the built image runs instead, under the same hardening as the
// other images and with its own settings only (P7); the same tests run against it. S2 adds the sign-in journeys.
const channel = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
const repo = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const image = process.env.E2E_CONSOLE_IMAGE;
// Inside a local release run, container names carry the run's ID, so only that run's containers are touched.
const run = process.env.UV_RELEASE_RUN ? `-${process.env.UV_RELEASE_RUN}` : '';

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
    command: image
      ? `node tools/images/run-container.mjs uv-e2e-console${run} ${image} --own PORT=3001 HOSTNAME=127.0.0.1 UNIVARSE_ENVIRONMENT=LOCAL`
      : 'pnpm --filter @univarse/console start',
    cwd: repo,
    url: 'http://127.0.0.1:3001/',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
