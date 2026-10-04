// DEV ONLY: runs the HTTP API and the outbox worker together, so codes reach Mailpit (spec 0002 B7).
// tsc-watch restarts this script after each successful build; both children stop with it.
import { spawn } from 'node:child_process';

const children = ['dist/main.js', 'dist/worker.js'].map((entry) =>
  spawn(process.execPath, ['--enable-source-maps', entry], { stdio: 'inherit' }),
);
const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
};
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', stop);
