import { defineConfig, devices } from '@playwright/test';

// Spec 0005 W10: the real chain — edge (:4180) → web (production build, :3000) → API (:8099) → DB.
// Run `pnpm build` first: the API serves from dist and `next start` serves .next.
// Locally, already-running servers are reused.
const reuse = !process.env.CI;
// Optional installed browser instead of Playwright's download, e.g. PW_CHANNEL=msedge locally.
const channel = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
const repo = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Spec 0013 CS5: with E2E_API_IMAGE and E2E_WEB_IMAGE set, the API, web and worker run as the built images under
// the CI hardening (tools/images/container.mjs) instead of from dist/ and .next. Same ports, same edge, same tests.
const apiImage = process.env.E2E_API_IMAGE;
const webImage = process.env.E2E_WEB_IMAGE;
const images = Boolean(apiImage && webImage);
// Inside a local release run, container names carry the run's ID, so only that run's containers are touched.
const run = process.env.UV_RELEASE_RUN ? `-${process.env.UV_RELEASE_RUN}` : '';

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
      command: images ? `node tools/images/run-container.mjs uv-e2e-api${run} ${apiImage} PORT=8099 TRUSTED_PROXIES=127.0.0.1` : 'node tools/dev-edge/start-api.mjs',
      cwd: repo,
      url: 'http://127.0.0.1:8099/health/live',
      reuseExistingServer: reuse,
      timeout: 60_000,
    },
    {
      command: images
        ? `node tools/images/run-container.mjs uv-e2e-web${run} ${webImage} PORT=3000 HOSTNAME=127.0.0.1 API_INTERNAL_URL=http://127.0.0.1:8099`
        : 'pnpm --filter @univarse/web start',
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
