// DEV ONLY: runs the HTTP API and the outbox worker together, so codes reach Mailpit (spec 0002 B7), and the platform
// API (spec 0027 P9) once `pnpm db:setup` has written its .env.console. Without that file it isn't started, so an
// older setup keeps working: one child's exit stops them all.
// tsc-watch restarts this script after each successful build; the children stop with it.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const consoleEnv = new URL('../../../.env.console', import.meta.url);
const entries = ['dist/main.js', 'dist/worker.js'];
if (existsSync(consoleEnv)) entries.push('dist/platform.js');
else console.log('[dev] the platform API is not started: no .env.console yet. Run `pnpm db:setup` to create the console role (spec 0027).');

const children = entries.map((entry) => spawn(process.execPath, ['--enable-source-maps', entry], { stdio: 'inherit' }));
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
};
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', stop);
