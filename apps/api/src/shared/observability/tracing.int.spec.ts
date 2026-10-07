// Spec 0012 OB6 (leak test, both ways), OB8 (context isolation), OB9 (traces for the API) against the real
// app. Tracing starts FIRST; the harness, app and drivers are imported only afterwards (OB9).
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestTracing, type TestTracing } from '../../testing/tracing.js';

type Harness = Awaited<ReturnType<(typeof import('../../testing/int-harness.js'))['createHarness']>>;
type Line = Record<string, unknown> & { event: string | null; requestId: string | null };

let t: TestTracing;
let h: Harness;
let app: NestFastifyApplication;
let H: typeof import('../../testing/int-harness.js');
let mfa: typeof import('../../testing/mfa-helpers.js');
let FileScanWorker: (typeof import('../../modules/files/file-scan.worker.js'))['FileScanWorker'];
const lines: Line[] = [];
const raw: string[] = [];

beforeAll(async () => {
  t = await startTestTracing();
  H = await import('../../testing/int-harness.js');
  mfa = await import('../../testing/mfa-helpers.js');
  ({ FileScanWorker } = await import('../../modules/files/file-scan.worker.js'));
  const { createApp } = await import('../../bootstrap.js');
  const { loadConfig } = await import('../../config/config.js');
  h = await H.createHarness();
  const destination = new Writable({
    write(chunk: Buffer, _e, done) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) {
        raw.push(l);
        lines.push(JSON.parse(l) as Line);
      }
      done();
    },
  });
  app = await createApp(loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'debug' }), { logDestination: destination });
}, 60_000);
afterAll(async () => {
  await app.close();
  await h.close();
});

// Type-only: erased at compile time, so it loads nothing before tracing starts.
type Res = import('../../testing/int-harness.js').InjectResult;
const inject = (o: { method?: 'GET' | 'POST' | 'PUT'; url: string; host?: string; cookie?: string; body?: object; headers?: Record<string, string> }): Promise<Res> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: o.method ?? 'GET',
      url: o.url,
      remoteAddress: H.randomIp(),
      headers: {
        host: o.host ?? H.HOSTS.demo,
        ...(o.method && o.method !== 'GET' ? { 'sec-fetch-site': 'same-origin' } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...o.headers,
      },
      ...(o.body ? { payload: o.body } : {}),
    });
const cookieOf = (res: Res, name: string) =>
  ([res.headers['set-cookie']].flat().filter(Boolean) as string[]).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
const spans = () => t.exporter.getFinishedSpans();
/** Lets every span of the work just done end, then exports it. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 100));
  await t.flush();
};
const rootOf = (requestId: string) => spans().find((s) => s.attributes['request.id'] === requestId && s.instrumentationScope.name === '@fastify/otel');
function descendants(root: ReadableSpan): ReadableSpan[] {
  const all = spans();
  const out: ReadableSpan[] = [];
  const frontier = [root.spanContext().spanId];
  while (frontier.length > 0) {
    const id = frontier.pop()!;
    for (const s of all) {
      if (s.parentSpanContext?.spanId === id) {
        out.push(s);
        frontier.push(s.spanContext().spanId);
      }
    }
  }
  return out;
}
const spanText = () =>
  JSON.stringify(spans().map((s) => ({ name: s.name, attributes: s.attributes, events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })) })));

describe('[OB9] traces for the API', () => {
  it('[OB9] a login is one trace: root named by route template, with pg and Valkey spans beneath it', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const res = await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: u.username, password: H.PASSWORD } });
    expect(res.statusCode).toBe(200);
    await settle();
    const root = rootOf(String(res.headers['x-request-id']))!;
    expect(root.name).toBe('POST /api/v1/auth/login');
    expect(root.attributes).toMatchObject({ 'http.route': '/api/v1/auth/login', 'tenant.id': h.tenants.demo, 'http.response.status_code': 200 });
    expect(root.resource.attributes['service.name']).toBe('api');
    if (process.env.TRACE_DUMP) {
      const tid = root.spanContext().traceId;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(process.env.TRACE_DUMP, JSON.stringify(spans().filter((s) => s.spanContext().traceId === tid).map((s) => ({ n: s.name, sc: s.instrumentationScope.name, id: s.spanContext().spanId, p: s.parentSpanContext?.spanId ?? null })), null, 1));
    }
    await settle();
    const below = descendants(root).map((s) => s.instrumentationScope.name);
    expect(below).toContain('@opentelemetry/instrumentation-pg');
    expect(below).toContain('@opentelemetry/instrumentation-ioredis');
    // Logs and spans agree on the trace.
    const line = lines.find((l) => l.requestId === res.headers['x-request-id'] && l.event === 'http.request');
    expect(line?.traceId).toBe(root.spanContext().traceId);
  });
});

describe('[OB6] the leak test: real flows leave no secret in any log line or span, and do leave useful output', () => {
  it('[OB6] login, lockout, 429, MFA verify, step-up, password reset, settings write, presigned upload + scan + download', async () => {
    const secrets: string[] = [H.PASSWORD];
    const keep = (s: string | undefined) => {
      if (s) secrets.push(s);
      return s;
    };
    const demo = h.tenants.demo;

    // Lockout: ten wrong passwords.
    const victim = await h.makeUser('demo', { role: 'STUDENT' });
    const wrong = keep(`Wrong-${randomBytes(6).toString('hex')}-9a`)!;
    for (let i = 0; i < 10; i++) await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: victim.username, password: wrong } });

    // 429: four reset requests for one identifier.
    const nobody = `nobody-${randomBytes(4).toString('hex')}`;
    for (let i = 0; i < 4; i++) await inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', body: { username: nobody } });

    // A query string carrying something secret-looking.
    const token = keep(`tok-${randomBytes(8).toString('hex')}`)!;
    await inject({ url: `/api/v1/tenant/public-profile?token=${token}` });

    // Login → session.
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const login = await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: u.username, password: H.PASSWORD } });
    keep(cookieOf(login, '__Host-uv_sid'));

    // MFA: challenge → verify with a TOTP code → step-up with password + a fresh code.
    const m = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const secret = await mfa.enrolTestTotp(h.shard, demo, m.id);
    const challenge = keep(cookieOf(await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: m.username, password: H.PASSWORD } }), '__Host-uv_mfa'))!;
    const code1 = keep(mfa.totpCode(secret))!;
    const verified = await inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', cookie: challenge, body: { code: code1 } });
    expect(verified.statusCode).toBe(200);
    let mSession = keep(cookieOf(verified, '__Host-uv_sid'))!;
    await mfa.resetReplayGuard(h.shard, demo, m.id);
    const code2 = keep(mfa.totpCode(secret))!;
    const stepped = await inject({ method: 'POST', url: '/api/v1/auth/step-up', cookie: mSession, body: { password: H.PASSWORD, code: code2 } });
    expect(stepped.statusCode).toBe(200);
    mSession = keep(cookieOf(stepped, '__Host-uv_sid'))!;

    // Settings write (institution admin, stepped up): read the ETag, write with If-Match.
    // A core setting: product switches made by other suites can't hide it.
    const read = await inject({ url: '/api/v1/settings/files.storageQuotaBytes', cookie: mSession });
    const put = await inject({ method: 'PUT', url: '/api/v1/settings/files.storageQuotaBytes', cookie: mSession, headers: { 'if-match': String(read.headers.etag) }, body: { value: 1_073_741_824 } });
    expect(put.statusCode).toBe(200);

    // Password reset: request → emailed code → confirm with a new password.
    const after = h.mailsTo(u.email!).length;
    await inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', body: { username: u.username } });
    const resetCode = keep(H.codeIn(await h.waitForMail(u.email!, /reset/i, after)))!;
    const newPassword = keep(`New-${randomBytes(6).toString('hex')}-Pw9`)!;
    expect((await inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', body: { username: u.username, code: resetCode, password: newPassword } })).statusCode).toBe(204);
    const session = keep(cookieOf(await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: u.username, password: newPassword } }), '__Host-uv_sid'))!;

    // Upload through the presigned POST, scan, download.
    const bytes = Buffer.from(`%PDF-1.4\n% leak test ${randomBytes(4).toString('hex')}\n%%EOF\n`);
    const slotRes = await inject({ method: 'POST', url: '/api/v1/files/uploads', cookie: session, body: { name: 'leak.pdf', mime: 'application/pdf', sizeBytes: bytes.length } });
    expect(slotRes.statusCode).toBe(201);
    const slot = slotRes.json() as { file: { id: string }; upload: { url: string; fields: Record<string, string> } };
    for (const k of ['X-Amz-Signature', 'Policy', 'X-Amz-Credential']) keep(slot.upload.fields[k]);
    const form = new FormData();
    for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'leak.pdf');
    expect((await fetch(slot.upload.url, { method: 'POST', body: form })).status).toBe(204);
    expect((await inject({ method: 'POST', url: `/api/v1/files/${slot.file.id}/complete`, cookie: session })).statusCode).toBe(200);
    const scanner = h.workerCtx.get(FileScanWorker);
    await scanner.scanTenant({ id: demo, shardId: (await h.platform.tenant.findUniqueOrThrow({ where: { id: demo } })).shardId });
    expect((await inject({ url: `/api/v1/files/${slot.file.id}/content`, cookie: session })).statusCode).toBe(200);
    await settle();

    // 1. Nothing leaks, anywhere: log lines, span names, attributes, events.
    const everything = `${raw.join('\n')}\n${spanText()}`;
    const leaked = secrets.filter((s) => s.length >= 6 && everything.includes(s));
    expect(leaked).toEqual([]);

    // 2. Something useful is there: a summary line per flow, roots with DB and Valkey work, security events.
    const routes = new Set(lines.filter((l) => l.event === 'http.request').map((l) => `${String(l.method)} ${String(l.route)}`));
    for (const r of [
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/mfa/verify',
      'POST /api/v1/auth/step-up',
      'POST /api/v1/auth/password-reset/request',
      'POST /api/v1/auth/password-reset/confirm',
      'PUT /api/v1/settings/:key',
      'POST /api/v1/files/uploads',
      'POST /api/v1/files/:id/complete',
      'GET /api/v1/files/:id/content',
    ]) {
      expect(routes, r).toContain(r);
      expect(spans().some((s) => s.name === r && s.instrumentationScope.name === '@fastify/otel'), `root span ${r}`).toBe(true);
    }
    const events = new Set(lines.map((l) => l.event));
    expect(events).toContain('auth.account.locked');
    expect(events).toContain('auth.rate_limited');
    const scopes = new Set(spans().map((s) => s.instrumentationScope.name));
    for (const s of ['@opentelemetry/instrumentation-pg', '@opentelemetry/instrumentation-ioredis', 'prisma']) expect(scopes, s).toContain(s);
    process.stdout.write(`\n[OB6] secrets checked ${String(secrets.length)}; log lines ${String(lines.length)}; spans ${String(spans().length)}; attribute keys dropped by the sanitizer: ${JSON.stringify(t.dropped)}\n`);
  }, 120_000);
});

describe('[OB8] context stays isolated', () => {
  it('[OB8] overlapping requests for tenants A and B, different users: every line and root span is attributed to its own request', async () => {
    const a = await h.makeUser('demo', { role: 'STUDENT' });
    const b = await h.makeUser('poly', { role: 'STUDENT' });
    const ca = cookieOf(await inject({ method: 'POST', url: '/api/v1/auth/login', body: { username: a.username, password: H.PASSWORD } }), '__Host-uv_sid')!;
    const cb = cookieOf(await inject({ method: 'POST', host: H.HOSTS.poly, url: '/api/v1/auth/login', body: { username: b.username, password: H.PASSWORD } }), '__Host-uv_sid')!;
    const who = [
      { host: H.HOSTS.demo, cookie: ca, tenant: h.tenants.demo, user: a.id },
      { host: H.HOSTS.poly, cookie: cb, tenant: h.tenants.poly, user: b.id },
    ];
    const results = await Promise.all(
      // 24 overlapping requests, 12 per tenant. (With synchronous per-span export this hit Prisma's 2 s
      // transaction wait, P2028; the helper now batches like production. Capacity is tracked separately.)
      Array.from({ length: 24 }, (_, i) => who[i % 2]!).map(async (w) => ({ w, res: await inject({ url: '/api/v1/files', host: w.host, cookie: w.cookie }) })),
    );
    await settle();
    for (const { w, res } of results) {
      const rid = String(res.headers['x-request-id']);
      expect(res.statusCode, JSON.stringify(lines.find((l) => l.requestId === rid && l.event === 'http.unhandled_error'))).toBe(200);
      const mine = lines.filter((l) => l.requestId === rid);
      expect(mine.length).toBeGreaterThan(0);
      for (const l of mine) expect([l.tenantId, l.userId], rid).toEqual([w.tenant, w.user]);
      const root = rootOf(rid)!;
      expect([root.attributes['tenant.id'], root.attributes['user.id']]).toEqual([w.tenant, w.user]);
      for (const l of mine) expect(l.traceId).toBe(root.spanContext().traceId);
    }
    // No two requests share a trace.
    expect(new Set(results.map(({ res }) => rootOf(String(res.headers['x-request-id']))!.spanContext().traceId)).size).toBe(results.length);
  });

  it('[OB8] trace headers carry no authority: baggage naming tenant B on A’s host changes nothing; traceparent only parents', async () => {
    const traceId = randomBytes(16).toString('hex');
    const res = await inject({
      url: '/api/v1/tenant/public-profile',
      host: H.HOSTS.demo,
      headers: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`, baggage: `tenant.id=${h.tenants.poly},user.id=attacker,univarse.tenant=${h.tenants.poly}` },
    });
    expect(res.statusCode).toBe(200);
    await settle();
    const rid = String(res.headers['x-request-id']);
    const root = rootOf(rid)!;
    expect(root.spanContext().traceId).toBe(traceId); // honoured as a parent
    expect(root.attributes['tenant.id']).toBe(h.tenants.demo); // from the Host
    expect(root.attributes['user.id']).toBeUndefined(); // public route, no session
    const line = lines.find((l) => l.requestId === rid && l.event === 'http.request')!;
    expect([line.tenantId, line.userId]).toEqual([h.tenants.demo, null]);
    expect(raw.filter((l) => l.includes(rid)).some((l) => l.includes('attacker') || l.includes(h.tenants.poly))).toBe(false);
    expect(JSON.stringify(spans().filter((s) => s.spanContext().traceId === traceId).map((s) => s.attributes))).not.toMatch(/attacker|baggage/);
  });
});
