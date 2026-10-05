// Starts the outbox worker for the E2E run (spec 0005 W15): requests never send email themselves
// (spec 0002 B7), so activation and reset codes only reach Mailpit if a worker is running.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): () => void {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  const worker = spawn(process.execPath, ['apps/api/dist/worker.js'], {
    cwd: repo,
    stdio: 'ignore',
    env: { ...process.env, WORKER_POLL_MS: '500' },
  });
  return () => {
    worker.kill();
  };
}
