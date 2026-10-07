// Spec 0012 OB12: the COMPILED API and worker, as two separate processes, each initialized by its own
// `--import ./dist/otel.js`, export to a real OpenTelemetry Collector (infra/compose/otel, `pnpm dev:traces`).
// Two journeys run through them; the collector's file output is then checked for STRUCTURE:
//   email: reset request (api) → outbox row → outbox.deliver (worker), one trace, parent chain unbroken;
//   file scan: complete (api) → files.scan (worker), a new trace with a link to the completing span;
//   pg spans from both processes, Valkey spans from the API (the worker has no Valkey client), service.name.
// Then SIGTERM: both exit cleanly within the flush deadline, and spans ended just before it are exported.
// Run: pnpm --filter @univarse/api build && pnpm dev:traces && pnpm --filter @univarse/api test:ob12
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHUTDOWN_FLUSH_MS } from './tracing.js';

type Harness = Awaited<ReturnType<(typeof import('../../testing/int-harness.js'))['createHarness']>>;

const API_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const OUT = fileURLToPath(new URL('../../../../../infra/compose/otel/out/traces.jsonl', import.meta.url));
const ENDPOINT = process.env.OB12_COLLECTOR ?? 'http://127.0.0.1:14318';
const PORT = 8098;
const HOST = 'demo-uni.univarse.localhost';

let H: typeof import('../../testing/int-harness.js');
let h: Harness;
let offset = 0;
const procs: Record<'api' | 'worker', ChildProcess | undefined> = { api: undefined, worker: undefined };
const output: Record<'api' | 'worker', string> = { api: '', worker: '' };

function start(name: 'api' | 'worker'): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OTEL_')));
  const p = spawn(process.execPath, ['--import', './dist/otel.js', `dist/${name === 'api' ? 'main' : 'worker'}.js`], {
    cwd: API_DIR,
    env: { ...env, NODE_ENV: 'development', LOG_LEVEL: 'warn', OTEL_EXPORTER_OTLP_ENDPOINT: ENDPOINT, PORT: String(PORT), WORKER_POLL_MS: '200', FILE_SCAN_INTERVAL_MS: '250' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d: Buffer) => (output[name] += d.toString()));
  p.stderr.on('data', (d: Buffer) => (output[name] += d.toString()));
  procs[name] = p;
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
/** node:http, not fetch: fetch won't send a custom Host, and the tenant comes from the Host. */
const call = (method: string, path: string, o: { body?: object; cookie?: string } = {}) =>
  new Promise<Res>((resolve, reject) => {
    const payload = o.body ? JSON.stringify(o.body) : undefined;
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        headers: {
          host: HOST,
          ...(method !== 'GET' ? { 'sec-fetch-site': 'same-origin' } : {}),
          ...(payload ? { 'content-type': 'application/json' } : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });

const waitFor = async <T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve(check()).catch(() => undefined);
    if (v !== undefined && v !== false) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}\napi:\n${output.api.slice(-2000)}\nworker:\n${output.worker.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
};

// ---- the collector's file output (OTLP JSON lines) ----
interface OtlpAttr {
  key: string;
  value: Record<string, unknown>;
}
interface Span {
  service: string;
  scope: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  links: { traceId: string; spanId: string }[];
  attributes: Record<string, unknown>;
}
const attrs = (a: OtlpAttr[] | undefined) => Object.fromEntries((a ?? []).map((x) => [x.key, Object.values(x.value)[0]]));
function spans(): Span[] {
  if (!existsSync(OUT)) return [];
  const text = readFileSync(OUT).subarray(offset).toString('utf8');
  const out: Span[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line) as {
      resourceSpans?: { resource?: { attributes?: OtlpAttr[] }; scopeSpans?: { scope?: { name?: string }; spans?: (Omit<Span, 'service' | 'scope' | 'attributes' | 'links' | 'parentSpanId'> & { parentSpanId?: string; attributes?: OtlpAttr[]; links?: { traceId: string; spanId: string }[] })[] }[] }[];
    };
    for (const rs of doc.resourceSpans ?? []) {
      const service = String(attrs(rs.resource?.attributes)['service.name']);
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          out.push({ ...s, service, scope: ss.scope?.name ?? '', parentSpanId: s.parentSpanId ?? '', links: s.links ?? [], attributes: attrs(s.attributes) });
        }
      }
    }
  }
  return out;
}
/** Parent chain within one trace: nearest first, up to the root (no parent) or a missing parent. */
function chain(all: Span[], s: Span): Span[] {
  const byId = new Map(all.filter((x) => x.traceId === s.traceId).map((x) => [x.spanId, x]));
  const out: Span[] = [];
  for (let p = byId.get(s.parentSpanId); p; p = byId.get(p.parentSpanId)) out.push(p);
  return out;
}

const cookieOf = (r: Res) => ([r.headers['set-cookie']].flat().filter(Boolean) as string[]).map((c) => c.split(';')[0]!).find((c) => c.startsWith('__Host-uv_sid='));

beforeAll(async () => {
  expect(existsSync(`${API_DIR}dist/otel.js`), 'build the API first: pnpm --filter @univarse/api build').toBe(true);
  const health = await fetch(ENDPOINT.replace(/:\d+$/, ':13133')).catch(() => undefined);
  expect(health?.ok, `start the collector first: pnpm dev:traces (health at ${ENDPOINT.replace(/:\d+$/, ':13133')})`).toBe(true);
  offset = existsSync(OUT) ? statSync(OUT).size : 0;
  H = await import('../../testing/int-harness.js');
  h = await H.createHarness(); // users and DB checks only; the journeys go through the compiled processes
  start('api');
  start('worker');
  await waitFor('the compiled API', async () => (await call('GET', '/health/live')).status === 200 || undefined);
}, 60_000);

afterAll(async () => {
  for (const p of Object.values(procs)) if (p && p.exitCode === null) p.kill('SIGKILL');
  // Undefined when beforeAll stopped early (no build, no collector): report that, not a TypeError.
  await (h as Harness | undefined)?.close();
});

describe('[OB12] compiled API and worker, separate processes, real collector', () => {
  let resetRid: string;
  let resetTraceparent: string;
  let completeRid: string;
  let fileTraceparent: string;

  it('[OB12] journeys: a reset email delivered by the worker, and an upload scanned by the worker', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const db = (await import('@univarse/db')).forTenant(h.shard, h.tenants.demo);

    // Email: the request writes the outbox row; the WORKER process delivers it.
    const reset = await call('POST', '/api/v1/auth/password-reset/request', { body: { username: u.username } });
    expect(reset.status).toBe(202);
    resetRid = String(reset.headers['x-request-id']);
    const row = await waitFor('the outbox row to be SENT by the worker process', async () => {
      const r = await db.outboxEvent.findFirst({ where: { traceparent: { not: null } }, orderBy: { occurredAt: 'desc' } });
      return r?.status === 'SENT' ? r : undefined;
    });
    resetTraceparent = row.traceparent!;

    // File scan: upload through the presigned POST, complete, and the WORKER process scans it.
    const login = await call('POST', '/api/v1/auth/login', { body: { username: u.username, password: H.PASSWORD } });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login)!;
    const bytes = Buffer.from(`%PDF-1.4\n% OB12 ${Date.now().toString(36)}\n%%EOF\n`);
    const slotRes = await call('POST', '/api/v1/files/uploads', { cookie, body: { name: 'ob12.pdf', mime: 'application/pdf', sizeBytes: bytes.length } });
    expect(slotRes.status).toBe(201);
    const slot = JSON.parse(slotRes.body) as { file: { id: string }; upload: { url: string; fields: Record<string, string> } };
    const form = new FormData();
    for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'ob12.pdf');
    expect((await fetch(slot.upload.url, { method: 'POST', body: form })).status).toBe(204);
    const complete = await call('POST', `/api/v1/files/${slot.file.id}/complete`, { cookie });
    expect(complete.status).toBe(200);
    completeRid = String(complete.headers['x-request-id']);
    const file = await waitFor('the worker process to scan the file', async () => {
      const f = await db.fileObject.findUniqueOrThrow({ where: { id: slot.file.id } });
      return f.state === 'CLEAN' ? f : undefined;
    });
    fileTraceparent = file.traceparent!;
    expect(resetTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(fileTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  }, 90_000);

  it('[OB12] email: outbox.deliver (worker) is in the reset request’s trace, and its parent chain reaches that request’s server span', async () => {
    const [, traceId, parentId] = resetTraceparent.split('-');
    const deliver = await waitFor('the delivery span in the collector output', () =>
      spans().find((s) => s.name === 'outbox.deliver' && s.traceId === traceId),
    );
    const all = await waitFor('the request root in the collector output', () => {
      const a = spans();
      return a.some((s) => s.attributes['request.id'] === resetRid) ? a : undefined;
    });
    const root = all.find((s) => s.attributes['request.id'] === resetRid && s.scope === '@fastify/otel')!;
    expect(root).toMatchObject({ service: 'api', name: 'POST /api/v1/auth/password-reset/request', traceId });
    expect(deliver).toMatchObject({ service: 'worker', kind: 5 /* CONSUMER */, parentSpanId: parentId });
    const up = chain(all, deliver);
    expect(up.length).toBeGreaterThan(0);
    expect(up.every((s) => s.service === 'api')).toBe(true); // the hop is api → worker, through the DB row
    expect(up.map((s) => s.spanId)).toContain(root.spanId);
    // The HTTP server span sits above the Fastify request span: the chain reaches the true root.
    expect(up.at(-1)!.parentSpanId).toBe('');
  });

  it('[OB12] file scan: files.scan (worker) is a new trace with a link to the completing request’s span', async () => {
    const [, traceId, spanId] = fileTraceparent.split('-');
    const scan = await waitFor('the scan span in the collector output', () => spans().find((s) => s.name === 'files.scan' && s.links.some((l) => l.traceId === traceId)));
    expect(scan.service).toBe('worker');
    expect(scan.parentSpanId).toBe('');
    expect(scan.traceId).not.toBe(traceId);
    expect(scan.links).toEqual([expect.objectContaining({ traceId, spanId })]);
    // The API exports in 2 s batches: wait for the linked span itself, not just the scan.
    const linked = await waitFor('the linked (completing request) span', () => spans().find((s) => s.spanId === spanId && s.traceId === traceId));
    expect(linked.service).toBe('api');
    const all = spans();
    const completeRoot = all.find((s) => s.attributes['request.id'] === completeRid && s.scope === '@fastify/otel')!;
    expect(completeRoot.traceId).toBe(traceId);
  });

  it('[OB12] both processes made pg spans; the API made Valkey spans; service.name is api / worker; nothing else', () => {
    const all = spans();
    const scopes = (svc: string) => new Set(all.filter((s) => s.service === svc).map((s) => s.scope));
    expect(scopes('api')).toContain('@opentelemetry/instrumentation-pg');
    expect(scopes('api')).toContain('@opentelemetry/instrumentation-ioredis');
    expect(scopes('worker')).toContain('@opentelemetry/instrumentation-pg');
    // pg work INSIDE the worker's row spans, not only around passes.
    const deliver = all.find((s) => s.name === 'outbox.deliver' && s.traceId === resetTraceparent.split('-')[1])!;
    expect(all.some((s) => s.service === 'worker' && s.scope === '@opentelemetry/instrumentation-pg' && chain(all, s).some((p) => p.spanId === deliver.spanId))).toBe(true);
    expect(new Set(all.map((s) => s.service))).toEqual(new Set(['api', 'worker']));
    process.stdout.write(`\n[OB12] collector spans: ${String(all.length)} (api ${String(all.filter((s) => s.service === 'api').length)}, worker ${String(all.filter((s) => s.service === 'worker').length)})\n`);
  });

  it.skipIf(process.platform === 'win32')('[OB11][OB12] SIGTERM: both exit cleanly within the flush deadline, exporting spans that ended just before', async () => {
    // Ended < 2 s (the batch delay) before SIGTERM: only the shutdown flush can export it.
    const last = await call('GET', '/api/v1/tenant/public-profile');
    expect(last.status).toBe(200);
    const rid = String(last.headers['x-request-id']);
    const t0 = Date.now();
    const exits = (['api', 'worker'] as const).map(
      (n) =>
        new Promise<{ n: string; code: number | null; signal: NodeJS.Signals | null; ms: number }>((r) =>
          procs[n]!.once('exit', (code, signal) => r({ n, code, signal, ms: Date.now() - t0 })),
        ),
    );
    for (const n of ['api', 'worker'] as const) procs[n]!.kill('SIGTERM');
    const done = await Promise.all(exits);
    process.stdout.write(`[OB12] shutdown: ${done.map((d) => `${d.n} exit ${String(d.code)} signal ${String(d.signal)} in ${String(d.ms)} ms`).join(', ')}\n`);
    for (const d of done) {
      // The worker exits 0 itself. The API uses Nest's enableShutdownHooks: it closes the app (running the
      // trace-flush hook) and then re-raises SIGTERM, so it ends BY the signal. Either is a clean shutdown; an
      // unclean one (a crash, a non-zero code) is not. Whether the hooks really ran is decided below: spans
      // that only the shutdown flush could have exported must arrive.
      expect(d.code === 0 || (d.code === null && d.signal === 'SIGTERM'), `${d.n}: code ${String(d.code)}, signal ${String(d.signal)}`).toBe(true);
      expect(d.ms, d.n).toBeLessThan(SHUTDOWN_FLUSH_MS + 3_000);
    }
    await waitFor('the last request’s spans, flushed at shutdown', () => spans().find((s) => s.attributes['request.id'] === rid), 10_000);
  }, 30_000);
});
