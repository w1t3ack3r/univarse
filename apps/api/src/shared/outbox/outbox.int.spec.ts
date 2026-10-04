/**
 * Spec 0002 Part B — outbox, worker, durable email. Every AC ID appears in a test name.
 * Prereqs: `pnpm db:migrate && pnpm db:seed`, Valkey running. Files run sequentially, and each test
 * flushes the outbox first, so only its own events are due.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { forTenant, withTenantTx } from '@univarse/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config/config.js';
import { ProductService } from '../../modules/products/product.service.js';
import { createHarness, HOSTS, type Harness } from '../../testing/int-harness.js';
import { WorkerModule } from '../../worker.module.js';
import { ShardRegistry } from '../db/db.module.js';
import { MAILER, type Mailer, type OutboundEmail } from '../infra/mailer.js';
import { MAX_ATTEMPTS } from './delivery-policy.js';
import { OutboxWorker } from './outbox-worker.js';
import { Outbox } from './outbox.js';

let h: Harness;
const contexts: INestApplicationContext[] = [];
const db = (t: 'demo' | 'poly' = 'demo') => forTenant(h.shard, h.tenants[t]);
const event = (id: string, t: 'demo' | 'poly' = 'demo') => db(t).outboxEvent.findUniqueOrThrow({ where: { id } });
const tenantRef = (t: 'demo' | 'poly') => ({ id: h.tenants[t], shardId: shardId });
let shardId: string;

/** Enqueues through the real Outbox service in a committed tenant transaction. */
async function enqueue(mail: Partial<OutboundEmail> = {}, o: { tenant?: 'demo' | 'poly'; product?: 'core' | 'admissions' } = {}) {
  const tenantId = h.tenants[o.tenant ?? 'demo'];
  return h.app.get(ShardRegistry).tx(shardId, tenantId, (tx) =>
    h.app.get(Outbox).enqueueEmail(tx, tenantId, { to: `${h.run.toLowerCase()}@test.local`, subject: 'Test', text: 'body', ...mail }, o.product),
  );
}

/** A separate worker process (own Nest context), with its own mailer. */
async function workerWith(mailer: Mailer): Promise<OutboxWorker> {
  const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(loadConfig({ ...process.env, NODE_ENV: 'test' }), { mailer }), { logger: false });
  contexts.push(ctx);
  return ctx.get(OutboxWorker);
}

beforeAll(async () => {
  h = await createHarness();
  shardId = (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await h.deliver();
});
afterAll(async () => {
  for (const c of contexts) await c.close();
  await h.close();
});

describe('[B1] enqueued in the business transaction', () => {
  it('[B1] a rolled-back transaction leaves no event', async () => {
    let id = '';
    await expect(
      h.app.get(ShardRegistry).tx(shardId, h.tenants.demo, async (tx) => {
        id = await h.app.get(Outbox).enqueueEmail(tx, h.tenants.demo, { to: 'x@test.local', subject: 's', text: 't' });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect(id).not.toBe('');
    expect(await db().outboxEvent.findUnique({ where: { id } })).toBeNull();
  });

  it('[B1] a rejected password reset (R5 policy failure) enqueues no notice', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    await h.call('POST', HOSTS.demo, '/api/v1/auth/password-reset/request', { body: { username: u.username } });
    const codeMail = await h.waitForMail(u.email!, /reset code/, 0);
    const code = /\b(\d{6})\b/.exec(codeMail.text)![1]!;
    const before = await db().outboxEvent.count();
    const res = await h.call('POST', HOSTS.demo, '/api/v1/auth/password-reset/confirm', { body: { username: u.username, code, password: 'password123' } });
    expect(res.statusCode).toBe(422);
    expect(await db().outboxEvent.count()).toBe(before);
  });
});

describe('[B2] encrypted payloads, wiped after delivery', () => {
  it('[B2] the row holds no plaintext; after delivery the payload is gone', async () => {
    const id = await enqueue({ subject: 'Secret code', text: 'Your code is 424242' });
    const row = await event(id);
    expect(row.payload).toBeNull();
    expect(row.payloadEnc).toBeTruthy();
    expect(row.payloadEnc).not.toMatch(/424242|test\.local|Secret/);
    expect(row.product).toBe('core');

    await h.deliver();
    const sent = await event(id);
    expect(sent).toMatchObject({ status: 'SENT', payloadEnc: null, attempts: 1, lastError: null });
    expect(sent.publishedAt).toBeInstanceOf(Date);
    expect(h.outbox.at(-1)).toMatchObject({ subject: 'Secret code', text: 'Your code is 424242' });
  });

  it('[B2] a payload copied onto another row does not decrypt (AAD binds the event id)', async () => {
    const a = await enqueue({ text: 'for A' });
    const b = await enqueue({ text: 'for B' });
    const encA = (await event(a)).payloadEnc!;
    await db().outboxEvent.update({ where: { id: b }, data: { payloadEnc: encA } });

    const counts = await h.worker.runTenant(tenantRef('demo'));
    expect(counts).toMatchObject({ claimed: 2, sent: 1, retried: 1 });
    expect(h.outbox.filter((m) => m.text === 'for A')).toHaveLength(1);
    expect(await event(b)).toMatchObject({ status: 'PENDING', attempts: 1 });
    await db().outboxEvent.update({ where: { id: b }, data: { status: 'DEAD' } }); // keep it out of later tests
  });
});

describe('[B3][B6] worker claims', () => {
  it('[B6] two concurrent workers deliver each event exactly once, with a Message-ID from the event id', async () => {
    const seen: OutboundEmail[] = [];
    const slow: Mailer = { send: async (m) => { await new Promise((r) => setTimeout(r, 20)); seen.push(m); } };
    const [w1, w2] = [await workerWith(slow), await workerWith(slow)];
    const ids = await Promise.all(Array.from({ length: 15 }, (_, i) => enqueue({ text: `concurrent ${i}` })));

    const drain = async (w: OutboxWorker) => { while ((await w.runTenant(tenantRef('demo'))).claimed > 0); };
    await Promise.all([drain(w1), drain(w2)]);

    const delivered = seen.map((m) => m.messageId);
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered.sort()).toEqual(ids.map((id) => `<${id}@univarse.localhost>`).sort());
  });
});

describe('[B4] retries', () => {
  it('[B4] failures back off with jitter, record no PII, and go DEAD after 8 attempts', async () => {
    const to = `ada-${h.run.toLowerCase()}@student.example`;
    const failing: Mailer = {
      send: (m) =>
        Promise.reject(Object.assign(new Error(`550 5.1.1 <${m.to}> mailbox unavailable`), { code: 'EENVELOPE', responseCode: 550 })),
    };
    const w = await workerWith(failing);
    const id = await enqueue({ to });

    const t0 = Date.now();
    expect(await w.runTenant(tenantRef('demo'))).toMatchObject({ claimed: 1, retried: 1 });
    const first = await event(id);
    expect(first).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Error:EENVELOPE:550' });
    const delay = first.nextAttemptAt.getTime() - t0;
    expect(delay).toBeGreaterThanOrEqual(24_000 - 1_000);
    expect(delay).toBeLessThanOrEqual(36_000 + 1_000);

    // Not due yet: a second pass doesn't touch it.
    expect((await w.runTenant(tenantRef('demo'))).claimed).toBe(0);

    for (let n = 2; n <= MAX_ATTEMPTS; n++) {
      await db().outboxEvent.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await w.runTenant(tenantRef('demo'));
    }
    const dead = await event(id);
    expect(dead).toMatchObject({ status: 'DEAD', attempts: MAX_ATTEMPTS });
    expect(dead.lastError).not.toMatch(/@|ada|mailbox/);

    await db().outboxEvent.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    expect((await w.runTenant(tenantRef('demo'))).claimed).toBe(0); // never retried again
  });
});

describe('[B5] durability', () => {
  it('[B5] an event written while no worker runs is delivered once a (new) worker starts', async () => {
    const seen: OutboundEmail[] = [];
    const id = await enqueue({ text: 'written while the worker was down' });
    expect((await event(id)).status).toBe('PENDING');

    const fresh = await workerWith({ send: (m) => { seen.push(m); return Promise.resolve(); } }); // "restart"
    await fresh.runOnce();
    expect(seen.map((m) => m.text)).toContain('written while the worker was down');
    expect((await event(id)).status).toBe('SENT');
  });
});

describe('[B7] request paths never send email', () => {
  it('[B7] the HTTP app has no mailer at all', () => {
    expect(() => h.app.get(MAILER, { strict: false })).toThrow();
  });

  it('[B7] a reset request only enqueues; delivery happens in the worker', async () => {
    const u = await h.makeUser('demo', { role: 'STUDENT' });
    const before = h.mailsTo(u.email!).length;
    const res = await h.call('POST', HOSTS.demo, '/api/v1/auth/password-reset/request', { body: { username: u.username } });
    expect(res.statusCode).toBe(202);
    expect(h.mailsTo(u.email!).length).toBe(before); // nothing sent by the request
    const pending = await db().outboxEvent.count({ where: { status: 'PENDING' } });
    expect(pending).toBe(1);
    await h.deliver();
    expect(h.mailsTo(u.email!).length).toBe(before + 1);
  });
});

describe('[B8] isolation', () => {
  it("[B8] a worker pass for tenant A never claims tenant B's events (live RLS)", async () => {
    const polyId = await enqueue({ text: 'for poly' }, { tenant: 'poly' });
    const counts = await h.worker.runTenant(tenantRef('demo'));
    expect(counts.claimed).toBe(0);
    expect((await event(polyId, 'poly')).status).toBe('PENDING');

    // RLS, not just the WHERE clause: under A's context B's rows are invisible.
    const visible = await withTenantTx(h.shard, h.tenants.demo, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM outbox_event WHERE tenant_id = ${h.tenants.poly}::uuid`,
    );
    expect(Number(visible[0]!.n)).toBe(0);

    await h.worker.runTenant(tenantRef('poly'));
    expect((await event(polyId, 'poly')).status).toBe('SENT');
  });
});

describe('[B9] observability', () => {
  it('[B9] logs counts per batch, never payloads or recipients', async () => {
    const log = vi.spyOn((h.worker as unknown as { logger: { log: (...a: unknown[]) => void } }).logger, 'log');
    await enqueue({ to: 'secret-recipient@test.local', subject: 'Secret subject', text: 'code 515151' });
    await h.worker.runTenant(tenantRef('demo'));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ claimed: 1, sent: 1, retried: 0, dead: 0 }), 'Outbox batch');
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-recipient|Secret subject|515151/);
  });
});

describe('[B10] products', () => {
  it('[B10] events of an inactive product wait without using attempts, then deliver once it is active', async () => {
    const id = await enqueue({ text: 'admissions notice' }, { product: 'admissions' });
    await h.deliver();
    expect(await event(id)).toMatchObject({ status: 'PENDING', attempts: 0 });

    const where = { tenantId_product: { tenantId: h.tenants.demo, product: 'admissions' } };
    await h.platform.tenantProduct.update({ where, data: { enabled: true } });
    try {
      h.workerCtx.get(ProductService).invalidate(h.tenants.demo); // the worker's own cache (P7 TTL otherwise)
      await h.deliver();
      expect(await event(id)).toMatchObject({ status: 'SENT', attempts: 1 });
    } finally {
      await h.platform.tenantProduct.update({ where, data: { enabled: false } });
      h.workerCtx.get(ProductService).invalidate(h.tenants.demo);
    }
  });
});
