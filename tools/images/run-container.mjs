// Spec 0013 CS5: runs one UniVarse image in the foreground under the CI hardening (container.mjs), for
// Playwright's webServer and the E2E global setup. Removes the container when this process is stopped.
//   node tools/images/run-container.mjs <name> <image> [--worker] [KEY=VALUE ...]
// KEY=VALUE pairs are non-secret settings (ports, URLs); secrets come from the environment only.
import { spawn, spawnSync } from 'node:child_process';
import { dockerRun, WORKER_CMD } from './container.mjs';

const [name, image, ...rest] = process.argv.slice(2);
if (!name || !image) {
  console.error('usage: run-container.mjs <name> <image> [--worker] [KEY=VALUE ...]');
  process.exit(2);
}
const extra = Object.fromEntries(rest.filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const cmd = rest.includes('--worker') ? WORKER_CMD : [];

spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); // a leftover from an aborted run
const { args, env } = dockerRun({ name, image, extra, cmd });
const id = spawnSync('docker', ['image', 'inspect', '-f', '{{.Id}}', image], { encoding: 'utf8' }).stdout.trim();
console.error(`[run-container] ${name}: ${image} (${id})`);
const child = spawn('docker', args, { env, stdio: 'inherit' });

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  child.kill();
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  stop();
  process.exit(0);
});
child.on('exit', (code) => {
  if (!stopping) spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  process.exit(code ?? 1);
});
