// Spec 0012 OB10 (request → worker propagation) and the worker half of OB8 (context isolation), in process
// against the real API and worker modules. The separate-process proof is OB12. Tracing starts FIRST.
import { randomBytes } from 'node:crypto';
import { SpanKind, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestTracing, type TestTracing } from '../../testing/tracing.js';

type Harness = Awaited<ReturnType<(typeof import('../../testing/int-harness.js'))['createHarness']>>;
type Res = import('../../testing/int-harness.js').InjectResult;
type Mailer = import('../infra/mailer.js').Mailer;

let t: TestTracing;
let h: Harness;
let H: typeof import('../../testing/int-harness.js');
let db: typeof import('@univarse/db');
let currentLogContext: (typeof import('./context.js'))['currentLogContext'];
let scanner: InstanceType<(typeof import('../../modules/files/file-scan.worker.js'))['FileScanWorker']>;
let mailer: Mailer;
/** Schema owner (migrator), inside the tenant's RLS context: the app role has no UPDATE on `traceparent`. */
let owner: import('@univarse/db').TenantShardClient;
let shardId: string;

beforeAll(async () => {
  t = await startTestTracing();
  H = await import('../../testing/int-harness.js');
  db = await import('@univarse/db');
  ({ currentLogContext } = await import('./context.js'));
  const { FileScanWorker } = await import('../../modules/files/file-scan.worker.js');
  const { MAILER } = await import('../infra/mailer.js');
  h = await H.createHarness();
  scanner = h.workerCtx.get(FileScanWorker);
  mailer = h.workerCtx.get<Mailer>(MAILER);
  shardId = (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId;
  owner = db.createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  await h.deliver();
}, 60_000);
afterAll(async () => {
  await owner.$disconnect();
  await h.close();
});

const hex = (n: number) => randomBytes(n).toString('hex');
const spans = () => t.exporter.getFinishedSpans();
const settle = async () => {
  await new Promise((r) => setTimeout(r, 100));
  await t.flush();
};
const rootOf = (res: Res) => spans().find((s) => s.attributes['request.id'] === res.headers['x-request-id'] && s.instrumentationScope.name === '@fastify/otel');
const byId = (spanId: string) => spans().find((s) => s.spanContext().spanId === spanId);
/** Follows parents up to the root; the chain is the spans visited, nearest first. */
function ancestry(s: ReadableSpan): ReadableSpan[] {
  const out: ReadableSpan[] = [];
  for (let p = s.parentSpanContext; p; ) {
    const next = byId(p.spanId);
    if (!next) break;
    out.push(next);
    p = next.parentSpanContext;
  }
  return out;
}
/** Pending rows (each test drains the outbox, so these are the rows it just wrote). Payloads are encrypted. */
const pending = (tenant: 'demo' | 'poly') => db.forTenant(h.shard, h.tenants[tenant]).outboxEvent.findMany({ where: { status: 'PENDING' }, orderBy: { occurredAt: 'asc' } });
const resetRequest = (tenant: 'demo' | 'poly', username: string, headers: Record<string, string> = {}) =>
  h.call('POST', H.HOSTS[tenant], '/api/v1/auth/password-reset/request', { body: { username }, headers });
const setTraceparent = (table: 'outbox_event' | 'file_object', id: string, value: string | null) =>
  db.withTenantTx(owner, h.tenants.demo, (tx) => tx.$executeRawUnsafe(`UPDATE ${table} SET traceparent = $1 WHERE id = $2::uuid`, value, id));
/** Records, at the moment of each send, which tenant the log context names and which span is active. */
function watchSends() {
  const seen: { to: string; tenantId: string | null | undefined; traceId: string | undefined; spanName: string | undefined }[] = [];
  const original = mailer.send.bind(mailer);
  const spy = vi.spyOn(mailer, 'send').mockImplementation(async (m) => {
    const span = trace.getActiveSpan() as (ReadableSpan & ReturnType<typeof trace.getActiveSpan>) | undefined;
    seen.push({ to: m.to, tenantId: currentLogContext()?.tenantId, traceId: span?.spanContext().traceId, spanName: span?.name });
    return original(m);
  });
  return { seen, restore: () => spy.mockRestore() };
}

describe('[OB10] outbox: the delivery joins the trace of the request that wrote the row', () => {
  it('[OB10] reset request → row stores its traceparent → outbox.deliver is a CONSUMER child in the same trace, reaching the request root', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const res = await resetRequest('demo', u.username);
    expect(res.statusCode).toBe(202);
    const [row, extra] = await pending('demo');
    expect(extra).toBeUndefined();
    expect(row?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    const sends = watchSends();
    await h.deliver();
    sends.restore();
    await settle();

    const root = rootOf(res)!;
    expect(row!.traceparent!.split('-')[1]).toBe(root.spanContext().traceId);
    const deliver = spans().find((s) => s.name === 'outbox.deliver' && s.attributes['univarse.outbox.event_id'] === row!.id)!;
    expect(deliver.kind).toBe(SpanKind.CONSUMER);
    expect(deliver.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(deliver.parentSpanContext?.spanId).toBe(row!.traceparent!.split('-')[2]);
    expect(ancestry(deliver).at(-1)?.spanContext().spanId).toBe(root.spanContext().spanId);
    expect(deliver.attributes).toMatchObject({ 'tenant.id': h.tenants.demo, 'univarse.outbox.outcome': 'sent' });
    // The send itself ran inside the delivery span and the tenant's log context.
    expect(sends.seen.find((s) => s.to === u.email)).toEqual({ to: u.email, tenantId: h.tenants.demo, traceId: root.spanContext().traceId, spanName: 'outbox.deliver' });
  });

  it('[OB10][OB7] an unsampled request leads to an unsampled delivery, and the email is still sent', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const traceId = hex(16);
    const before = h.mailsTo(u.email!).length;
    expect((await resetRequest('demo', u.username, { traceparent: `00-${traceId}-${hex(8)}-00` })).statusCode).toBe(202);
    const [row, extra] = await pending('demo');
    expect(extra).toBeUndefined();
    expect(row?.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-00$`));
    await h.deliver();
    await settle();
    expect(h.mailsTo(u.email!).length).toBe(before + 1);
    expect(spans().filter((s) => s.spanContext().traceId === traceId)).toEqual([]);
    expect(spans().some((s) => s.name === 'outbox.deliver' && s.attributes['univarse.outbox.event_id'] === row!.id)).toBe(false);
  });

  it('[OB10] rows with no context (older rows, tracing off) and with a malformed one still deliver, under a new root; malformed warns once', async () => {
    const a = await h.makeUser('demo', { role: 'STUDENT' });
    const b = await h.makeUser('demo', { role: 'STUDENT' });
    await resetRequest('demo', a.username);
    await resetRequest('demo', b.username);
    const rows = await pending('demo');
    expect(rows).toHaveLength(2);
    const [nullRow, badRow] = rows;
    await setTraceparent('outbox_event', nullRow!.id, null);
    await setTraceparent('outbox_event', badRow!.id, 'not-a-traceparent');
    const warn = vi.spyOn((h.worker as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');
    const before = [a, b].map((u) => h.mailsTo(u.email!).length);
    await h.deliver();
    await settle();
    expect([a, b].map((u) => h.mailsTo(u.email!).length)).toEqual(before.map((n) => n + 1));
    for (const r of [nullRow!, badRow!]) {
      const d = spans().find((s) => s.name === 'outbox.deliver' && s.attributes['univarse.outbox.event_id'] === r.id)!;
      expect(d.parentSpanContext, r.id).toBeUndefined();
      expect(d.attributes['univarse.outbox.outcome']).toBe('sent');
    }
    const malformed = warn.mock.calls.filter(([o]) => (o as { event?: string }).event === 'outbox.traceparent_malformed');
    expect(malformed).toHaveLength(1);
    expect(malformed[0]![0]).toMatchObject({ eventId: badRow!.id, tenantId: h.tenants.demo });
    expect(JSON.stringify(malformed)).not.toContain('not-a-traceparent');
    warn.mockRestore();
  });

  it('[OB10] a worker pass is one outbox.pass span; its claim query sits beneath it', async () => {
    await h.deliver();
    await settle();
    const pass = spans().filter((s) => s.name === 'outbox.pass').at(-1)!;
    expect(pass.parentSpanContext).toBeUndefined();
    expect(spans().some((s) => s.parentSpanContext?.spanId === pass.spanContext().spanId)).toBe(true);
  });
});

describe('[OB8] worker context stays isolated', () => {
  it("[OB8] rows for tenants A and B in ONE pass: each send runs in its own tenant's log context and its own request's trace", async () => {
    const pairs = await Promise.all(
      (['demo', 'poly', 'demo', 'poly'] as const).map(async (tenant) => {
        const u = await h.makeUser(tenant, { role: 'STUDENT' });
        const res = await resetRequest(tenant, u.username);
        expect(res.statusCode).toBe(202);
        return { tenant, email: u.email!, res };
      }),
    );
    const sends = watchSends();
    const counts = await h.worker.runOnce(); // one pass, both tenants
    sends.restore();
    expect(counts.sent).toBeGreaterThanOrEqual(4);
    await settle();
    const traceIds = new Set<string>();
    for (const p of pairs) {
      const seen = sends.seen.filter((s) => s.to === p.email);
      expect(seen, p.email).toHaveLength(1);
      const root = rootOf(p.res)!;
      expect(seen[0]).toEqual({ to: p.email, tenantId: h.tenants[p.tenant], traceId: root.spanContext().traceId, spanName: 'outbox.deliver' });
      traceIds.add(root.spanContext().traceId);
    }
    expect(traceIds.size).toBe(pairs.length);
    // Outside a row, the pass carries no tenant.
    const pass = spans().filter((s) => s.name === 'outbox.pass').at(-1)!;
    expect(pass.attributes['tenant.id']).toBeUndefined();
  });
});

describe('[OB10] file scans: a new trace, linked to the upload, sampled exactly when the upload was', () => {
  async function upload(headers: Record<string, string> = {}) {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const login = await h.call('POST', H.HOSTS.demo, '/api/v1/auth/login', { body: { username: u.username, password: H.PASSWORD } });
    const cookie = ([login.headers['set-cookie']].flat() as string[]).map((c) => c.split(';')[0]!).find((c) => c.startsWith('__Host-uv_sid='))!;
    const bytes = Buffer.from(`%PDF-1.4\n% propagation ${hex(4)}\n%%EOF\n`);
    const slotRes = await h.call('POST', H.HOSTS.demo, '/api/v1/files/uploads', { cookie, body: { name: 'p.pdf', mime: 'application/pdf', sizeBytes: bytes.length } });
    expect(slotRes.statusCode).toBe(201);
    const slot = slotRes.json() as { file: { id: string }; upload: { url: string; fields: Record<string, string> } };
    const form = new FormData();
    for (const [k, v] of Object.entries(slot.upload.fields)) form.append(k, v);
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'p.pdf');
    expect((await fetch(slot.upload.url, { method: 'POST', body: form })).status).toBe(204);
    const complete = await h.call('POST', H.HOSTS.demo, `/api/v1/files/${slot.file.id}/complete`, { cookie, headers });
    expect(complete.statusCode).toBe(200);
    return { id: slot.file.id, complete };
  }
  const fileRow = (id: string) => db.forTenant(h.shard, h.tenants.demo).fileObject.findUniqueOrThrow({ where: { id } });
  const scanDemo = () => scanner.scanTenant({ id: h.tenants.demo, shardId });
  const scanSpan = (id: string) => spans().find((s) => s.name === 'files.scan' && s.attributes['univarse.file.id'] === id);

  it('[OB10] complete stores its traceparent; files.scan is a root in a NEW trace with a link to it, attributed to the tenant', async () => {
    const { id, complete } = await upload();
    const row = await fileRow(id);
    expect(row.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    await scanDemo();
    await settle();
    const root = rootOf(complete)!;
    expect(row.traceparent!.split('-')[1]).toBe(root.spanContext().traceId);
    const scan = scanSpan(id)!;
    expect(scan.parentSpanContext).toBeUndefined();
    expect(scan.spanContext().traceId).not.toBe(root.spanContext().traceId);
    expect(scan.links.map((l) => [l.context.traceId, l.context.spanId])).toEqual([[root.spanContext().traceId, row.traceparent!.split('-')[2]]]);
    expect(scan.attributes).toMatchObject({ 'tenant.id': h.tenants.demo, 'univarse.scan.outcome': 'clean' });
    expect((await fileRow(id)).state).toBe('CLEAN');
  });

  it('[OB10][OB7] an unsampled upload leads to an unsampled scan, and the file is still scanned', async () => {
    const traceId = hex(16);
    const { id } = await upload({ traceparent: `00-${traceId}-${hex(8)}-00` });
    expect((await fileRow(id)).traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-00$`));
    await scanDemo();
    await settle();
    expect(scanSpan(id)).toBeUndefined();
    expect((await fileRow(id)).state).toBe('CLEAN');
  });

  it('[OB10] a malformed stored context: scanned under a fresh root with no link, one warning', async () => {
    const { id } = await upload();
    await setTraceparent('file_object', id, '00-zz-not-valid');
    const warn = vi.spyOn((scanner as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');
    await scanDemo();
    await settle();
    const scan = scanSpan(id)!;
    expect(scan.parentSpanContext).toBeUndefined();
    expect(scan.links).toEqual([]);
    expect((await fileRow(id)).state).toBe('CLEAN');
    const malformed = warn.mock.calls.filter(([o]) => (o as { event?: string }).event === 'files.scan.traceparent_malformed');
    expect(malformed).toHaveLength(1);
    expect(malformed[0]![0]).toMatchObject({ fileId: id, tenantId: h.tenants.demo });
    warn.mockRestore();
  });
});
