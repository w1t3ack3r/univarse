// Spec 0012 OB11: a failing collector never degrades the API or the worker. The real OTLP/HTTP exporter and
// the production export gate point at a collector this test controls, on one port throughout:
//   healthy (answers 200) → stalled (accepts, never answers) → unavailable (connection refused) → stalled again
// for the shutdown deadline. Small bounds make the queue limit reachable in a few requests.
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestTracing, type TestTracing } from '../../testing/tracing.js';
import type { ExportDegraded } from './tracing.js';

type Harness = Awaited<ReturnType<(typeof import('../../testing/int-harness.js'))['createHarness']>>;
type Mode = 'healthy' | 'stalled';

// The export timeout is LONGER than the flush deadline, so a stalled export would outlast it: the deadline,
// not the timeout, must be what ends shutdown.
const BOUNDS = { maxQueueSize: 200, maxExportBatchSize: 20, scheduledDelayMillis: 50, exportTimeoutMillis: 3_000 };
const FLUSH_MS = 1_000;

let t: TestTracing;
let h: Harness;
let H: typeof import('../../testing/int-harness.js');
let server: Server | undefined;
let port = 0;
let mode: Mode = 'healthy';
let received = 0;
const sockets = new Set<Socket>();
const reports: ExportDegraded[] = [];

async function listen(m: Mode): Promise<void> {
  mode = m;
  server = createServer((req, res) => {
    received++;
    req.resume();
    if (mode === 'healthy') req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'));
    // stalled: the request is read and never answered
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server!.listen(port, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
}
async function down(): Promise<void> {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
}

let cookie: string;
const stats = () => t.tracing.export!.stats;
/** 20 authenticated requests (DB + Valkey + ~25 spans each), sequential; returns the median latency. */
async function burst(): Promise<{ median: number; peak: number }> {
  const ms: number[] = [];
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const res = await h.call('GET', H.HOSTS.demo, '/api/v1/files', { cookie });
    ms.push(performance.now() - t0);
    expect(res.statusCode).toBe(200);
    peak = Math.max(peak, stats().queued);
  }
  ms.sort((a, b) => a - b);
  return { median: ms[10]!, peak };
}
/** A reset request and its delivery by the worker; returns the delivery time. */
async function emailJourney(): Promise<number> {
  const u = await h.makeUser('demo', { role: 'STUDENT' });
  const before = h.mailsTo(u.email!).length;
  expect((await h.call('POST', H.HOSTS.demo, '/api/v1/auth/password-reset/request', { body: { username: u.username } })).statusCode).toBe(202);
  const t0 = performance.now();
  await h.deliver();
  const took = performance.now() - t0;
  expect(h.mailsTo(u.email!).length).toBe(before + 1);
  return took;
}
// "Normal latency plus a small margin": generous for a loaded CI box, far below the 3 s export timeout
// that a request waiting on export would show.
const within = (degraded: number, baseline: number) => expect(degraded, `baseline ${baseline.toFixed(1)} ms`).toBeLessThan(baseline * 1.5 + 75);

let baseline: { median: number; mail: number };

beforeAll(async () => {
  await listen('healthy');
  t = await startTestTracing({ endpoint: `http://127.0.0.1:${String(port)}`, bounds: BOUNDS, shutdownFlushMs: FLUSH_MS, onExportDegraded: (d) => reports.push(d) });
  H = await import('../../testing/int-harness.js');
  h = await H.createHarness();
  const u = await h.makeUser('demo', { role: 'STUDENT' });
  const login = await h.call('POST', H.HOSTS.demo, '/api/v1/auth/login', { body: { username: u.username, password: H.PASSWORD } });
  cookie = ([login.headers['set-cookie']].flat() as string[]).map((c) => c.split(';')[0]!).find((c) => c.startsWith('__Host-uv_sid='))!;
  await h.deliver();
}, 60_000);
afterAll(async () => {
  await h.close();
  if (server) await down();
});

describe('[OB11] a failing collector never degrades the API or the worker', () => {
  it('[OB11] baseline, healthy collector: spans are exported; nothing dropped or reported', async () => {
    await burst(); // warm-up
    const { median } = await burst();
    const mail = await emailJourney();
    await t.flush();
    baseline = { median, mail };
    expect(received).toBeGreaterThan(0);
    expect(stats()).toMatchObject({ dropped: 0, failed: 0 });
    expect(stats().exported).toBeGreaterThan(400);
    expect(reports).toEqual([]);
    process.stdout.write(`\n[OB11] baseline: request median ${median.toFixed(1)} ms, email delivery ${mail.toFixed(1)} ms\n`);
  });

  it('[OB11] stalled collector: requests and jobs keep their latency; the queue stays at its bound; drops counted, ONE warning', async () => {
    mode = 'stalled';
    const r1 = await burst();
    const r2 = await burst();
    const mail = await emailJourney();
    process.stdout.write(`[OB11] stalled: medians ${r1.median.toFixed(1)}/${r2.median.toFixed(1)} ms, email ${mail.toFixed(1)} ms, peak queue ${String(stats().maxQueued)}, dropped ${String(stats().dropped)}\n`);
    within(Math.min(r1.median, r2.median), baseline.median);
    within(mail, baseline.mail);
    expect(Math.max(r1.peak, r2.peak, stats().maxQueued)).toBeLessThanOrEqual(BOUNDS.maxQueueSize);
    expect(stats().maxQueued).toBe(BOUNDS.maxQueueSize); // it really filled
    expect(stats().dropped).toBeGreaterThan(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ maxQueueSize: BOUNDS.maxQueueSize });
  }, 60_000);

  it('[OB11] unavailable collector (connection refused): the same; failures counted, no further warning inside the window', async () => {
    await down();
    const failedBefore = stats().failed;
    const r = await burst();
    const mail = await emailJourney();
    await new Promise((res) => setTimeout(res, 1_000)); // refused connections fail fast
    process.stdout.write(`[OB11] unavailable: median ${r.median.toFixed(1)} ms, email ${mail.toFixed(1)} ms, failed ${String(stats().failed)}\n`);
    within(r.median, baseline.median);
    within(mail, baseline.mail);
    expect(stats().maxQueued).toBeLessThanOrEqual(BOUNDS.maxQueueSize);
    expect(stats().failed).toBeGreaterThan(failedBefore);
    expect(reports).toHaveLength(1); // rate-limited: one per EXPORT_WARN_EVERY_MS
  }, 60_000);

  it('[OB11] closing the API and the worker runs their shutdown hook (main.ts and worker.ts pass shutdownTracing)', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { createApp } = await import('../../bootstrap.js');
    const { loadConfig } = await import('../../config/config.js');
    const { WorkerModule } = await import('../../worker.module.js');
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
    const calls: string[] = [];
    const app = await createApp(config, { onShutdown: () => Promise.resolve(void calls.push('api')) });
    const worker = await NestFactory.createApplicationContext(
      WorkerModule.forRoot(config, { mailer: { send: () => Promise.resolve() }, onShutdown: () => Promise.resolve(void calls.push('worker')) }),
      { logger: false },
    );
    expect(calls).toEqual([]);
    await app.close();
    await worker.close();
    expect(calls).toEqual(['api', 'worker']);
    // And the entrypoints really pass it.
    const { readFileSync } = await import('node:fs');
    for (const f of ['../../main.ts', '../../worker.ts']) expect(readFileSync(new URL(f, import.meta.url), 'utf8'), f).toMatch(/onShutdown: shutdownTracing/);
  });

  it('[OB11] shutdown with a full queue and a stalled collector finishes within the flush deadline', async () => {
    await listen('stalled');
    await burst(); // refill the queue
    expect(stats().queued).toBeGreaterThan(0);
    const t0 = performance.now();
    await t.tracing.shutdown();
    const took = performance.now() - t0;
    process.stdout.write(`[OB11] shutdown took ${took.toFixed(0)} ms (deadline ${String(FLUSH_MS)} ms)\n`);
    expect(took).toBeLessThan(FLUSH_MS + 250);
    expect(took).toBeGreaterThan(FLUSH_MS - 100); // the stall was real: the deadline ended it, not the export
    // Repeated calls (SIGTERM then SIGINT) share the same bounded shutdown.
    const t1 = performance.now();
    await t.tracing.shutdown();
    expect(performance.now() - t1).toBeLessThan(50);
  }, 60_000);
});
