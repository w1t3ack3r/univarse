// Spec 0034: the worker for the console's journeys. It runs provisioning (one job at a time, queued every half second
// here), checks every second whether a new institution's administrator is ready, and delivers the tenant outbox, so
// the first administrator's invitation reaches Mailpit. Built from dist, as the platform API is (`pnpm build` first).
// Not with E2E_CONSOLE_IMAGE: the image's frame tests need no platform API and no worker.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): () => void {
  if (process.env.E2E_CONSOLE_IMAGE) return () => undefined;
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const worker = spawn(process.execPath, ['apps/api/dist/worker.js'], {
    cwd: repo,
    stdio: 'ignore',
    env: { ...process.env, WORKER_POLL_MS: '500', PROVISIONING_RELAY_INTERVAL_MS: '500', ONBOARDING_CHECK_INTERVAL_MS: '1000' },
  });
  return () => {
    worker.kill();
  };
}
