// DEV ONLY: runs the HTTP API and the outbox worker together, so codes reach Mailpit (spec 0002 B7), and the platform
// API (spec 0027 P9) once `pnpm db:setup` has written its .env.console. Without that file it isn't started, so an
// older setup keeps working: one child's exit stops them all.
// tsc-watch restarts this script after each successful build; the children stop with it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const consoleEnv = new URL('../../../.env.console', import.meta.url);
const entries = ['dist/main.js', 'dist/worker.js'];
// Spec 0028: a file from before S2 lacks the console's pepper, and the platform API would refuse to start and, as one
// child's exit stops them all, take the tenant API and worker down with it.
const consoleReady = existsSync(consoleEnv) && Boolean(parseEnv(readFileSync(consoleEnv, 'utf8')).CONSOLE_CODE_PEPPER);
if (consoleReady) entries.push('dist/platform.js');
else console.log('[dev] the platform API is not started: .env.console is missing or from before spec 0028. Run `pnpm db:setup` (it keeps the console\'s keys if they exist).');

// The tenant API sits behind the dev edge (:4180), as on the stack: on :8099, where the edge and the web app's server
// components send it, trusting forwarding headers from 127.0.0.1 only (tools/dev-edge/start-api.mjs does the same).
const behindEdge = { PORT: process.env.PORT ?? '8099', TRUSTED_PROXIES: process.env.TRUSTED_PROXIES ?? '127.0.0.1' };
const envOf = (entry) => (entry === 'dist/main.js' ? { ...process.env, ...behindEdge } : process.env);
const children = entries.map((entry) => spawn(process.execPath, ['--enable-source-maps', entry], { stdio: 'inherit', env: envOf(entry) }));
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
};
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', stop);
