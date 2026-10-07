// Spec 0012 OB11: with no collector endpoint configured, the COMPILED API and worker make zero OTLP export
// attempts. An SDK can auto-configure a default OTLP exporter when none is supplied; leaving the endpoint
// unset proves nothing on its own. A receiver listens on the OTLP default port (4318) and must stay silent.
// Needs `pnpm --filter @univarse/api build` (as RS8 does).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const PORT = 8097;
const hits: string[] = [];
let receiver: Server;
const procs: ChildProcess[] = [];

/** The environment of a deployed process with observability off: no OTEL_* variables at all. */
function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OTEL_')));
  return { ...env, NODE_ENV: 'development', LOG_LEVEL: 'warn', ...extra };
}

function start(entry: 'main.js' | 'worker.js', extra: Record<string, string> = {}): ChildProcess {
  const p = spawn(process.execPath, ['--import', './dist/otel.js', `dist/${entry}`], { cwd: API_DIR, env: cleanEnv(extra), stdio: 'ignore' });
  procs.push(p);
  return p;
}

/** node:http, not fetch: fetch won't send a custom Host, and the tenant comes from the Host. */
const get = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });

const waitFor = async (check: () => Promise<boolean>, ms: number) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

beforeAll(async () => {
  expect(existsSync(`${API_DIR}dist/otel.js`), 'build the API first: pnpm --filter @univarse/api build').toBe(true);
  receiver = createServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''}`);
    req.resume();
    res.end('{}');
  });
  await new Promise<void>((r) => receiver.listen(4318, '127.0.0.1', r));
}, 30_000);

afterAll(async () => {
  for (const p of procs) p.kill();
  await new Promise((r) => receiver.close(r));
});

describe('[OB11] no endpoint configured: nothing is exported', () => {
  it('[OB11] the compiled API and worker, under traffic and worker passes, never contact an OTLP endpoint', async () => {
    start('main.js', { PORT: String(PORT) });
    start('worker.js', { WORKER_POLL_MS: '200', FILE_SCAN_INTERVAL_MS: '250' });
    const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${String(PORT)}/health/live`)).ok, 30_000);
    expect(up, 'the compiled API started').toBe(true);
    // Traffic that produces spans: a tenant request with DB work (asserted 200), and an unknown route.
    for (let i = 0; i < 5; i++) {
      expect(await get('/api/v1/tenant/public-profile', 'demo-uni.univarse.localhost')).toBe(200);
      expect(await get('/api/v1/nowhere', 'demo-uni.univarse.localhost')).toBe(404);
    }
    // Longer than the batch processor's 2 s schedule, with the worker polling every 200 ms meanwhile.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(procs.every((p) => p.exitCode === null), 'both processes still running').toBe(true);
    expect(hits).toEqual([]);
  }, 90_000);
});
