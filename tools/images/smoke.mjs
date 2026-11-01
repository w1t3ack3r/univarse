// Spec 0013 CS4: run the built images under the hardened runtime against the CI services, and check they work.
//   node tools/images/smoke.mjs --api <image> --web <image> --console <image>
// Hardening and environment come from container.mjs (shared with the CS5 browser journeys).
// Spec 0027: the console image, and the api image's platform role, run with their own settings only (never the
// tenant API's), and the platform role refuses to start when handed a tenant credential.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { parseEnv } from 'node:util';
import { dockerRun, PLATFORM_CMD, WORKER_CMD } from './container.mjs';
import { runSuffix } from './release-lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const API_IMAGE = arg('api');
const WEB_IMAGE = arg('web');
const CONSOLE_IMAGE = arg('console');
if (!API_IMAGE || !WEB_IMAGE || !CONSOLE_IMAGE) {
  console.error('usage: smoke.mjs --api <image> --web <image> --console <image>');
  process.exit(2);
}
// The console role's URL, from `pnpm db:setup` (.env.console). Never loaded into this process's environment.
const consoleEnv = new URL('../../.env.console', import.meta.url);
const CONSOLE_DATABASE_URL = existsSync(consoleEnv) ? parseEnv(readFileSync(consoleEnv, 'utf8')).CONSOLE_DATABASE_URL : undefined;

const API_PORT = '8090';
const WEB_PORT = '3090';
const PLATFORM_PORT = '8093';
const CONSOLE_PORT = '3093';
const HOST = 'demo-uni.univarse.localhost';
// Unique per release run (see release-lib runSuffix), so this never touches another run's or anyone's containers.
const N = {
  api: `uv-smoke-api${runSuffix()}`,
  worker: `uv-smoke-worker${runSuffix()}`,
  web: `uv-smoke-web${runSuffix()}`,
  platform: `uv-smoke-platform${runSuffix()}`,
  console: `uv-smoke-console${runSuffix()}`,
};

const names = [];
function run(name, image, extra, cmd = [], own = false) {
  const { args, env } = dockerRun({ name, image, extra, cmd, detach: true, own });
  const r = spawnSync('docker', args, { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
  names.push(name);
}
const logs = (name) => spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout + spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stderr;
/** GET; resolves the status, or 0 when nothing answered. `full` resolves { status, headers, body } instead. */
const get = (port, path, host = HOST, full = false) =>
  new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: Number(port), path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(full ? { status: res.statusCode ?? 0, headers: res.headers, body } : (res.statusCode ?? 0)));
    });
    req.on('error', () => resolve(full ? { status: 0, headers: {}, body: '' } : 0));
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
  run(N.api, API_IMAGE, { PORT: API_PORT, HOST: '127.0.0.1' });
  run(N.worker, API_IMAGE, {}, WORKER_CMD);
  run(N.web, WEB_IMAGE, { PORT: WEB_PORT, HOSTNAME: '127.0.0.1', API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}` });

  await waitFor('API /health/live', async () => (await get(API_PORT, '/health/live')) === 200);
  for (const [path, want] of [['/health/live', 200], ['/health/ready', 200], ['/api/v1/tenant/public-profile', 200]]) {
    const got = await get(API_PORT, path);
    if (got !== want) problems.push(`API ${path}: ${got}, expected ${want}`);
  }
  await waitFor('worker.started', async () => logs(N.worker).includes('"event":"worker.started"'), 30_000).catch((e) => problems.push(String(e)));
  await waitFor('web /login', async () => (await get(WEB_PORT, '/login')) === 200, 60_000).catch((e) => problems.push(String(e)));

  // Spec 0027 P1, P5: the platform API from the same api image, with the console role's URL and nothing else.
  if (!CONSOLE_DATABASE_URL) problems.push('no CONSOLE_DATABASE_URL in .env.console: run pnpm db:setup');
  else {
    run(N.platform, API_IMAGE, { PORT: PLATFORM_PORT, HOST: '127.0.0.1', CONSOLE_DATABASE_URL, CONSOLE_ALLOWLIST: '127.0.0.1' }, PLATFORM_CMD, true);
    await waitFor('platform API /health/ready', async () => (await get(PLATFORM_PORT, '/health/ready')) === 200).catch((e) => problems.push(String(e)));
    // Its walls: the tenant API's routes aren't here, and an unknown platform route is the same plain 404.
    for (const path of ['/api/v1/tenant/public-profile', '/api/platform/v1/smoke']) {
      const got = await get(PLATFORM_PORT, path);
      if (got !== 404) problems.push(`platform API ${path}: ${got}, expected 404`);
    }
  }
  // Spec 0027 P6: the console's frame, with its nonce CSP, never indexed.
  run(N.console, CONSOLE_IMAGE, { PORT: CONSOLE_PORT, HOSTNAME: '127.0.0.1', UNIVARSE_ENVIRONMENT: 'LOCAL' }, [], true);
  await waitFor('console /', async () => (await get(CONSOLE_PORT, '/', 'console.univarse.localhost')) === 200, 60_000).catch((e) => problems.push(String(e)));
  const frame = await get(CONSOLE_PORT, '/', 'console.univarse.localhost', true);
  if (!frame.body.includes('Platform console')) problems.push('console /: the frame is not served');
  if (!/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/.test(String(frame.headers['content-security-policy'] ?? ''))) problems.push('console /: no nonce CSP');
  if (frame.headers['x-robots-tag'] !== 'noindex, nofollow') problems.push('console /: not marked noindex');

  // API, worker and platform API: stdout is JSON lines only (spec 0012 OB1). The Next.js images aren't (spec 0013 CS4).
  for (const n of [N.api, N.worker, ...(CONSOLE_DATABASE_URL ? [N.platform] : [])]) {
    const out = spawnSync('docker', ['logs', n], { encoding: 'utf8' }).stdout;
    const bad = out.split('\n').filter((l) => l.trim() && !isJson(l));
    if (bad.length > 0) problems.push(`${n}: ${bad.length} non-JSON stdout line(s), first: ${bad[0].slice(0, 160)}`);
  }
  for (const n of names) {
    const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', n], { encoding: 'utf8' }).stdout.trim();
    if (!state.startsWith('running')) problems.push(`${n} not running: ${state}`);
  }

  // Spec 0019 C1 (LS8): the same images refuse a plaintext VAULT_ADDR at start, loopback included: given the dev
  // Vault's plain listener, the API and the worker each exit, naming the rule, and serve nothing.
  for (const [what, cmd] of [['API', []], ['worker', WORKER_CMD]]) {
    const name = `uv-smoke-plain-${what.toLowerCase()}${runSuffix()}`;
    const { args, env } = dockerRun({ name, image: API_IMAGE, extra: { PORT: '8091', HOST: '127.0.0.1', VAULT_ADDR: 'http://127.0.0.1:8200' }, cmd });
    const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60_000 });
    spawnSync('docker', ['rm', '-f', '-v', name]); // only if it outlived the timeout
    if (r.status === 0 || r.status === null) problems.push(`${what} with a plaintext VAULT_ADDR did not refuse to start (exit ${String(r.status)})`);
    else if (!`${r.stdout}${r.stderr}`.includes('VAULT_ADDR must be https://')) problems.push(`${what} with a plaintext VAULT_ADDR exited ${String(r.status)}, but not for the plaintext rule`);
  }

  // Spec 0027 P-A2: handed a tenant credential (named, never shown), the platform API refuses to start.
  if (CONSOLE_DATABASE_URL) {
    const name = `uv-smoke-platform-tenant${runSuffix()}`;
    const extra = { PORT: '8094', HOST: '127.0.0.1', CONSOLE_DATABASE_URL, CONSOLE_ALLOWLIST: '127.0.0.1', PLATFORM_DATABASE_URL: CONSOLE_DATABASE_URL };
    const { args, env } = dockerRun({ name, image: API_IMAGE, extra, cmd: PLATFORM_CMD, own: true });
    const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 60_000 });
    spawnSync('docker', ['rm', '-f', '-v', name]); // only if it outlived the timeout
    const out = `${r.stdout}${r.stderr}`;
    if (r.status === 0 || r.status === null) problems.push(`the platform API with a tenant credential did not refuse to start (exit ${String(r.status)})`);
    else if (!out.includes('PLATFORM_DATABASE_URL: set, but the platform API holds no tenant or app credential')) problems.push(`the platform API with a tenant credential exited ${String(r.status)}, but not for that rule`);
    else if (out.includes(CONSOLE_DATABASE_URL)) problems.push('the platform API printed a database URL while refusing it');
  }
} catch (e) {
  problems.push(String(e));
} finally {
  if (problems.length > 0) for (const n of names) console.error(`--- ${n} logs (tail) ---\n${logs(n).split('\n').slice(-25).join('\n')}`);
  for (const n of names) spawnSync('docker', ['rm', '-f', '-v', n]);
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[smoke] FAIL ${p}`);
  process.exit(1);
}
console.log('[smoke] PASS: API health + DB-backed tenant request, worker started, web /login, the platform API (ready as the console role, its 404 walls, a tenant credential refused at start), the console frame (nonce CSP, noindex), JSON-only API/worker/platform stdout, Vault over TLS only (a plaintext VAULT_ADDR refused at start); all under read-only, UID 65532, no capabilities, no-new-privileges');

function isJson(l) {
  try {
    JSON.parse(l);
    return true;
  } catch {
    return false;
  }
}
