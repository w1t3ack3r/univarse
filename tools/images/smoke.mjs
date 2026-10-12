// Spec 0013 CS4: run the built images under the hardened runtime against the CI services, and check they work.
//   node tools/images/smoke.mjs --api <image> --web <image>
// Hardening and environment come from container.mjs (shared with the CS5 browser journeys).
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { dockerRun, WORKER_CMD } from './container.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const API_IMAGE = arg('api');
const WEB_IMAGE = arg('web');
if (!API_IMAGE || !WEB_IMAGE) {
  console.error('usage: smoke.mjs --api <image> --web <image>');
  process.exit(2);
}

const API_PORT = '8090';
const WEB_PORT = '3090';
const HOST = 'demo-uni.univarse.localhost';

const names = [];
function run(name, image, extra, cmd = []) {
  const { args, env } = dockerRun({ name, image, extra, cmd, detach: true });
  const r = spawnSync('docker', args, { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
  names.push(name);
}
const logs = (name) => spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout + spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stderr;
const get = (port, path, host = HOST) =>
  new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: Number(port), path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', () => resolve(0));
    req.setTimeout(5_000, () => req.destroy());
    req.end();
  });
async function waitFor(what, check, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const problems = [];
try {
  run('uv-smoke-api', API_IMAGE, { PORT: API_PORT, HOST: '127.0.0.1' });
  run('uv-smoke-worker', API_IMAGE, {}, WORKER_CMD);
  run('uv-smoke-web', WEB_IMAGE, { PORT: WEB_PORT, HOSTNAME: '127.0.0.1', API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}` });

  await waitFor('API /health/live', async () => (await get(API_PORT, '/health/live')) === 200);
  for (const [path, want] of [['/health/live', 200], ['/health/ready', 200], ['/api/v1/tenant/public-profile', 200]]) {
    const got = await get(API_PORT, path);
    if (got !== want) problems.push(`API ${path}: ${got}, expected ${want}`);
  }
  await waitFor('worker.started', async () => logs('uv-smoke-worker').includes('"event":"worker.started"'), 30_000).catch((e) => problems.push(String(e)));
  await waitFor('web /login', async () => (await get(WEB_PORT, '/login')) === 200, 60_000).catch((e) => problems.push(String(e)));

  // API and worker: stdout is JSON lines only (spec 0012 OB1). The web image isn't held to this (spec 0013 CS4).
  for (const n of ['uv-smoke-api', 'uv-smoke-worker']) {
    const out = spawnSync('docker', ['logs', n], { encoding: 'utf8' }).stdout;
    const bad = out.split('\n').filter((l) => l.trim() && !isJson(l));
    if (bad.length > 0) problems.push(`${n}: ${bad.length} non-JSON stdout line(s), first: ${bad[0].slice(0, 160)}`);
  }
  for (const n of names) {
    const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', n], { encoding: 'utf8' }).stdout.trim();
    if (!state.startsWith('running')) problems.push(`${n} not running: ${state}`);
  }
} catch (e) {
  problems.push(String(e));
} finally {
  if (problems.length > 0) for (const n of names) console.error(`--- ${n} logs (tail) ---\n${logs(n).split('\n').slice(-25).join('\n')}`);
  for (const n of names) spawnSync('docker', ['rm', '-f', n]);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[smoke] FAIL ${p}`);
  process.exit(1);
}
console.log('[smoke] PASS: API health + DB-backed tenant request, worker started, web /login, JSON-only API/worker stdout; all under read-only, UID 65532, no capabilities, no-new-privileges');

function isJson(l) {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}
