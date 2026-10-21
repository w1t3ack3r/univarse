// Starts the outbox worker for the E2E run (spec 0005 W15): requests never send email themselves
// (spec 0002 B7), so activation and reset codes only reach Mailpit if a worker is running.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): () => void {
  // Spec 0019 B4: against the stack, its own worker delivers the mail.
  if (process.env.E2E_STACK === '1') return () => undefined;
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  // Spec 0013 CS5: with E2E_API_IMAGE set, the worker is the built image under the CI hardening.
  const image = process.env.E2E_API_IMAGE;
  const worker = image
    ? spawn(process.execPath, ['tools/images/run-container.mjs', `uv-e2e-worker${process.env.UV_RELEASE_RUN ? `-${process.env.UV_RELEASE_RUN}` : ''}`, image, '--worker', 'WORKER_POLL_MS=500'], { cwd: repo, stdio: 'ignore' })
    : spawn(process.execPath, ['apps/api/dist/worker.js'], {
        cwd: repo,
        stdio: 'ignore',
        env: { ...process.env, WORKER_POLL_MS: '500' },
      });
  return () => {
    worker.kill();
  };
}
