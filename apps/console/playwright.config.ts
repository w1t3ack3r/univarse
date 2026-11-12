import { defineConfig, devices } from '@playwright/test';

// Spec 0027 P6, spec 0028 PR B: the console's frame and journeys through the dev edge (:4180) → console (`next start`,
// :3001) and platform API (dist, :8081) → the platform database as the console role. Run `pnpm build` first, and
// `pnpm db:setup` (for .env.console). Mail goes to Mailpit through the platform API's own relay. With
// E2E_CONSOLE_IMAGE set (CI's image job, the release), the built image runs alone, under the same hardening as the
// other images and with its own settings only (P7), and only the frame's tests run: they need no platform API.
const channel = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};
const repo = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const image = process.env.E2E_CONSOLE_IMAGE;
// Inside a local release run, container names carry the run's ID, so only that run's containers are touched.
const run = process.env.UV_RELEASE_RUN ? `-${process.env.UV_RELEASE_RUN}` : '';

const reuse = !process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testMatch: image ? 'frame.e2e.ts' : '**/*.e2e.ts',
  // The worker runs provisioning for the journeys (spec 0034); the teardown retires the members and institutions they made.
  ...(image ? {} : { globalSetup: './e2e/global-setup.ts', globalTeardown: './e2e/global-teardown.ts' }),
  fullyParallel: false, // the journeys run in order; each test signs in from its own address (fixtures.randomClientIp)
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  timeout: 30_000,
  use: { baseURL: image ? 'http://127.0.0.1:3001' : 'http://console.univarse.localhost:4180', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 360, height: 780 }, ...channel } },
  ],
  webServer: image
    ? {
        command: `node tools/images/run-container.mjs uv-e2e-console${run} ${image} --own PORT=3001 HOSTNAME=127.0.0.1 UNIVARSE_ENVIRONMENT=LOCAL`,
        cwd: repo,
        url: 'http://127.0.0.1:3001/',
        reuseExistingServer: reuse,
        timeout: 60_000,
      }
    : [
        // platform.js reads .env.console itself, never the root .env. It trusts the dev edge, as the tenant API does
        // (tools/dev-edge/start-api.mjs), so each test's own loopback address (fixtures.randomClientIp) reaches the
        // allowlist and the per-address sign-in limit: twenty a minute from one address is a real limit, and a whole
        // suite from one address crosses it.
        { command: 'node apps/api/dist/platform.js', cwd: repo, env: { TRUSTED_PROXIES: '127.0.0.1', CONSOLE_ALLOWLIST: '127.0.0.0/8,::1' }, url: 'http://127.0.0.1:8081/health/live', reuseExistingServer: reuse, timeout: 60_000 },
        { command: 'pnpm --filter @univarse/console start', cwd: repo, url: 'http://127.0.0.1:3001/sign-in', reuseExistingServer: reuse, timeout: 60_000 },
        { command: 'node tools/dev-edge/server.mjs', cwd: repo, port: 4180, reuseExistingServer: reuse, timeout: 30_000 },
      ],
});
