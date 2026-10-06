/**
 * Spec 0010 — file uploads against REAL SeaweedFS and REAL ClamAV (plus a fake clamd for failures).
 * Every AC ID appears in a test name. Prereqs: `pnpm dev:infra` (seaweedfs, clamav with the test
 * signature), `pnpm db:migrate && pnpm db:seed`.
 * EICAR and the test marker are assembled at run time; no file in the repo holds either.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { forTenant, withTenantTx } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/config.js';
import { createHarness, HOSTS, PASSWORD, type Harness, type InjectResult } from '../../testing/int-harness.js';
import { resetReplayGuard, totpCode } from '../../testing/mfa-helpers.js';
import { WorkerModule } from '../../worker.module.js';
import { base32Decode } from '../identity/totp.js';
import { ClamdScanner } from './clamd-scanner.js';
import { FileScanWorker, MAX_ATTEMPTS } from './file-scan.worker.js';
import { FileStorage } from './file-storage.js';
import { FilesService, reservedTotal } from './files.service.js';

let h: Harness;
let worker: FileScanWorker;
let storage: FileStorage;
const contexts: INestApplicationContext[] = [];
const servers: Server[] = [];
const D = HOSTS.demo;
const P = HOSTS.poly;
let demo: { id: string; shardId: string };

// --- run-time test content (never stored in the repo) -------------------------------------------
const EICAR = Buffer.from([88,53,79,33,80,37,64,65,80,91,52,92,80,90,88,53,52,40,80,94,41,55,67,67,41,55,125,36,69,73,67,65,82,45,83,84,65,78,68,65,82,68,45,65,78,84,73,86,73,82,85,83,45,84,69,83,84,45,70,73,76,69,33,36,72,43,72,42]);
const MARKER = ['UNIVARSE', 'CLAMAV', 'TEST', 'MARKER', '7d41c2e9a05b'].join('-');
const pdf = (body = 'hello') => Buffer.from(`%PDF-1.4\n% ${body} ${randomBytes(6).toString('hex')}\n%%EOF\n`);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);
const markerPdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(MARKER), Buffer.from(`\n${randomBytes(4).toString('hex')}\n%%EOF\n`)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// --- people ----------------------------------------------------------------------------------------
const sessionOf = (res: InjectResult): string => {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
  return all.find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
};
async function student(tenant: 'demo' | 'poly' = 'demo') {
  const u = await h.makeUser(tenant, { role: 'STUDENT' });
  return { ...u, session: sessionOf(await h.login(HOSTS[tenant], u.username)) };
}

// --- the flow ----------------------------------------------------------------------------------------
interface Slot {
  file: { id: string; state: string };
  upload: { url: string; fields: Record<string, string> };
}
async function slot(session: string, name: string, mime: string, sizeBytes: number, host = D): Promise<InjectResult> {
  return h.call('POST', host, '/api/v1/files/uploads', { cookie: session, body: { name, mime, sizeBytes } });
}
async function postToStorage(s: Slot, bytes: Buffer, mime: string): Promise<number> {
  const form = new FormData();
  for (const [k, v] of Object.entries(s.upload.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: mime }), 'upload');
  return (await fetch(s.upload.url, { method: 'POST', body: form })).status;
}
/** Slot → POST to storage → complete. Returns the slot. */
async function upload(session: string, bytes: Buffer, o: { name?: string; mime?: string; declared?: number } = {}): Promise<Slot> {
  const mime = o.mime ?? 'application/pdf';
  const res = await slot(session, o.name ?? 'doc.pdf', mime, o.declared ?? bytes.length);
  expect(res.statusCode, res.body).toBe(201);
  const s = res.json() as Slot;
  await postToStorage(s, bytes, mime);
  expect((await h.call('POST', D, `/api/v1/files/${s.file.id}/complete`, { cookie: session })).statusCode).toBe(200);
  return s;
}
const fileRow = (id: string) => forTenant(h.shard, demo.id).fileObject.findUniqueOrThrow({ where: { id } });
/** Runs the worker until the file leaves UPLOADED/SCANNING (or attempts run out). */
async function scanUntilDone(id: string, w: FileScanWorker = worker, maxPasses = 6): Promise<string> {
  for (let i = 0; i < maxPasses; i++) {
    await w.scanTenant(demo);
    const f = await fileRow(id);
    if (f.state !== 'UPLOADED' && f.state !== 'SCANNING') return f.state;
    // Skip the backoff wait in tests: make the retry due now.
    await forTenant(h.shard, demo.id).fileObject.updateMany({ where: { id, state: 'UPLOADED' }, data: { nextScanAt: new Date(0) } });
  }
  return (await fileRow(id)).state;
}
const view = (session: string, id: string, host: string = D) => h.call('GET', host, `/api/v1/files/${id}`, { cookie: session });
const download = (session: string, id: string, host: string = D) => h.call('GET', host, `/api/v1/files/${id}/content`, { cookie: session });

/** A worker whose clamd is a fake TCP server with the given behaviour. */
async function workerWithFakeClamd(behaviour: 'silent' | 'size-limit' | 'garbage'): Promise<FileScanWorker> {
  const server = createServer((sock) => {
    sock.on('data', () => undefined);
    if (behaviour === 'size-limit') sock.end('INSTREAM size limit exceeded. ERROR\0');
    if (behaviour === 'garbage') sock.end('stream: maybe?\0');
    // 'silent': never answers; the client times out.
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', CLAMD_PORT: String(port), CLAMD_TIMEOUT_MS: '1000' });
  const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(cfg, { mailer: { send: () => Promise.resolve() } }), { logger: false });
  contexts.push(ctx);
  return ctx.get(FileScanWorker);
}

beforeAll(async () => {
  h = await createHarness();
  worker = h.workerCtx.get(FileScanWorker);
  storage = h.workerCtx.get(FileStorage);
  demo = { id: h.tenants.demo, shardId: (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants.demo } })).shardId };
}, 60_000);
afterAll(async () => {
  for (const c of contexts) await c.close();
  for (const s of servers) s.close();
  await h.close();
});

describe('[FU9][FU10] the real flow: upload → scan → download → delete', () => {
  it('[FU10] clean PDF, PNG and JPEG: CLEAN, and the downloaded bytes equal the uploaded bytes', async () => {
    const me = await student();
    for (const [bytes, name, mime] of [[pdf(), 'a.pdf', 'application/pdf'], [png(), 'b.png', 'image/png'], [jpeg(), 'c.jpg', 'image/jpeg']] as const) {
      const s = await upload(me.session, bytes, { name, mime });
      expect(await scanUntilDone(s.file.id)).toBe('CLEAN');
      const res = await download(me.session, s.file.id);
      expect(res.statusCode).toBe(200);
      expect(sha(res.rawPayload)).toBe(sha(bytes));
    }
  });

  it('[FU5] downloads carry safe headers: detected type, attachment, nosniff, sandbox CSP, no-store', async () => {
    const me = await student();
    const s = await upload(me.session, pdf(), { name: 'Report "Q3"\r\n.pdf' });
    await scanUntilDone(s.file.id);
    const res = await download(me.session, s.file.id);
    expect(res.headers['content-type']).toBe('application/pdf');
    // Quotes and CR/LF were stripped from the name at upload: no header injection is possible.
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Report Q3.pdf"; filename*=UTF-8''Report%20Q3.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('[FU3] nothing is downloadable before it is CLEAN: the owner gets 409 file.not_ready', async () => {
    const me = await student();
    const s = await upload(me.session, pdf());
    const res = await download(me.session, s.file.id);
    expect([res.statusCode, res.json().code]).toEqual([409, 'file.not_ready']);
  });

  it('[FU7][FU8] delete removes both objects, is idempotent, and every step is audited', async () => {
    const me = await student();
    const s = await upload(me.session, pdf());
    await scanUntilDone(s.file.id);
    expect((await download(me.session, s.file.id)).statusCode).toBe(200);
    expect((await h.call('DELETE', D, `/api/v1/files/${s.file.id}`, { cookie: me.session })).statusCode).toBe(204);
    expect((await h.call('DELETE', D, `/api/v1/files/${s.file.id}`, { cookie: me.session })).statusCode).toBe(404);
    const row = await fileRow(s.file.id);
    expect(row).toMatchObject({ state: 'DELETED', reservedBytes: 0n, cleanKey: null, quarantineKey: null });
    expect((await storage.readBounded(storage.clean, `tenants/${demo.id}/c/${s.file.id}`, 10_000)).kind).toBe('missing');
    const events = await forTenant(h.shard, demo.id).auditEvent.findMany({ where: { entityType: 'file_object', entityId: s.file.id }, orderBy: { seq: 'asc' } });
    expect(events.map((e) => e.action)).toEqual(['files.upload.requested', 'files.upload.completed', 'files.scan.clean', 'files.downloaded', 'files.deleted']);
  });
});

describe('[FU5] content validation and limits', () => {
  it('[FU5] the slot refuses a disallowed type, a mismatched extension and an oversize declaration', async () => {
    const me = await student();
    expect((await slot(me.session, 'x.exe', 'application/x-msdownload', 10)).json().code).toBe('file.type_not_allowed');
    expect((await slot(me.session, 'x.png', 'application/pdf', 10)).json().code).toBe('file.type_not_allowed');
    expect((await slot(me.session, 'x.pdf', 'application/pdf', 5 * 1024 * 1024 + 1)).json().code).toBe('file.too_large');
  });

  it('[FU5] bytes that are not what was declared are REJECTED (type_mismatch), never scanned clean', async () => {
    const me = await student();
    const s = await upload(me.session, png(), { name: 'fake.pdf', mime: 'application/pdf' });
    expect(await scanUntilDone(s.file.id)).toBe('REJECTED');
    expect((await fileRow(s.file.id)).rejectionReason).toBe('type_mismatch');
  });

  it('[FU5][FU11] the storage refuses bytes beyond the declared size; the file ends REJECTED (upload_missing)', async () => {
    const me = await student();
    const res = await slot(me.session, 'small.pdf', 'application/pdf', 20);
    const s = res.json() as Slot;
    expect(await postToStorage(s, pdf('far more than twenty bytes of content'), 'application/pdf')).toBe(400);
    await h.call('POST', D, `/api/v1/files/${s.file.id}/complete`, { cookie: me.session });
    expect(await scanUntilDone(s.file.id)).toBe('REJECTED');
    expect((await fileRow(s.file.id)).rejectionReason).toBe('upload_missing');
  });
});

describe('[FU16] real malware detection through ClamAV', () => {
  it('[FU16] scanner wiring: EICAR sent straight to clamd through our client is FOUND', async () => {
    const v = await h.workerCtx.get(ClamdScanner).scan(EICAR);
    expect(v.verdict).toBe('infected');
  });

  it('[FU16] a valid PDF carrying the test marker passes the type check and is blocked by ClamAV (signature recorded)', async () => {
    const me = await student();
    const s = await upload(me.session, markerPdf());
    expect(await scanUntilDone(s.file.id)).toBe('INFECTED');
    const row = await fileRow(s.file.id);
    expect(row.detectedType).toBeNull(); // never reached promotion
    expect(row.scanSignature).toBe('UniVarse.Test.Marker-1.UNOFFICIAL');
    expect(row.reservedBytes).toBe(0n);
    expect((await download(me.session, s.file.id)).statusCode).toBe(409);
  });

  it('[FU16] plain EICAR through the upload flow is REJECTED by the type check (not scanner evidence)', async () => {
    const me = await student();
    const s = await upload(me.session, EICAR, { name: 'eicar.pdf' });
    expect(await scanUntilDone(s.file.id)).toBe('REJECTED');
    expect((await fileRow(s.file.id)).rejectionReason).toBe('type_not_allowed');
  });
});

describe('[FU3] the scanner failing never releases a file', () => {
  for (const behaviour of ['silent', 'size-limit', 'garbage'] as const) {
    it(`[FU3] clamd ${behaviour === 'silent' ? 'timing out' : behaviour === 'size-limit' ? 'refusing on size' : 'answering nonsense'}: retried, then SCAN_FAILED, never CLEAN`, async () => {
      const w = await workerWithFakeClamd(behaviour);
      const me = await student();
      const s = await upload(me.session, pdf());
      expect(await scanUntilDone(s.file.id, w, MAX_ATTEMPTS + 1)).toBe('SCAN_FAILED');
      const row = await fileRow(s.file.id);
      expect(row).toMatchObject({ scanAttempts: MAX_ATTEMPTS, reservedBytes: 0n, cleanKey: null });
      expect((await download(me.session, s.file.id)).statusCode).toBe(409);
    }, 60_000);
  }

  it('[FU3] clamd down (connection refused): stays unavailable', async () => {
    const cfg = loadConfig({ ...process.env, NODE_ENV: 'test', CLAMD_PORT: '9' });
    const ctx = await NestFactory.createApplicationContext(WorkerModule.forRoot(cfg, { mailer: { send: () => Promise.resolve() } }), { logger: false });
    contexts.push(ctx);
    const me = await student();
    const s = await upload(me.session, pdf());
    expect(await scanUntilDone(s.file.id, ctx.get(FileScanWorker), 1)).toBe('UPLOADED');
    expect((await fileRow(s.file.id)).scanAttempts).toBe(1);
    expect(await scanUntilDone(s.file.id)).toBe('CLEAN'); // a healthy scanner later decides
  });

  it('[FU3][FU7] a worker crash mid-scan: the lease lapses and a later pass scans again from the start', async () => {
    const me = await student();
    const s = await upload(me.session, pdf());
    worker.beforeFinalize = () => Promise.reject(new Error('crash'));
    await worker.scanTenant(demo).catch(() => undefined);
    worker.beforeFinalize = null;
    expect((await fileRow(s.file.id)).state).toBe('SCANNING');
    await forTenant(h.shard, demo.id).fileObject.update({ where: { id: s.file.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    expect(await scanUntilDone(s.file.id)).toBe('CLEAN');
    expect((await fileRow(s.file.id)).scanAttempts).toBe(2);
  });
});

describe('[FU4][FU14] the downloaded bytes are the scanned bytes', () => {
  it('[FU4] a reused upload URL overwriting quarantine DURING the scan changes nothing that is served', async () => {
    const me = await student();
    const original = pdf('original');
    const s = await upload(me.session, original);
    worker.beforeFinalize = async () => {
      // The attacker reuses the still-valid POST after the scanner read the bytes (same size: the
      // policy's size range still applies).
      expect(await postToStorage(s, Buffer.alloc(original.length, 0x58), 'application/pdf')).toBe(204);
    };
    expect(await scanUntilDone(s.file.id)).toBe('CLEAN');
    worker.beforeFinalize = null;
    expect(sha((await download(me.session, s.file.id)).rawPayload)).toBe(sha(original));
  });

  it('[FU4][FU7] reusing the URL AFTER promotion recreates only an orphan, which cleanup removes', async () => {
    const me = await student();
    const original = pdf('kept');
    const s = await upload(me.session, original);
    await scanUntilDone(s.file.id);
    expect(await postToStorage(s, Buffer.alloc(original.length, 0x58), 'application/pdf')).toBe(204);
    const { orphans } = await worker.cleanup(demo);
    expect(orphans).toBeGreaterThanOrEqual(1);
    expect((await storage.readBounded(storage.quarantine, `tenants/${demo.id}/q/${s.file.id}`, 10_000)).kind).toBe('missing');
    expect(sha((await download(me.session, s.file.id)).rawPayload)).toBe(sha(original));
  });

  it('[FU14] a tampered clean object is refused before any byte is sent', async () => {
    const me = await student();
    const s = await upload(me.session, pdf('true'));
    await scanUntilDone(s.file.id);
    // Same length as the original: only the fingerprint check can catch it (not the size bound).
    const original = (await fileRow(s.file.id)).sizeBytes;
    const tampered = Buffer.concat([Buffer.from('%PDF-1.4 TAMPERED-CONTENT'), Buffer.alloc(Number(original), 0x20)]).subarray(0, Number(original));
    await storage.put(storage.clean, `tenants/${demo.id}/c/${s.file.id}`, tampered, 'application/pdf');
    const res = await download(me.session, s.file.id);
    expect([res.statusCode, res.json().code]).toEqual([500, 'server.internal']);
    expect(res.body).not.toContain('TAMPERED-CONTENT');
  });
});

describe('[FU15] deletion wins against an in-flight scan', () => {
  it('[FU15] delete while the scan is held: stays DELETED, no clean object, reservation released once', async () => {
    const me = await student();
    const bytes = pdf('to be deleted');
    const s = await upload(me.session, bytes);
    const before = await withTenantTx(h.shard, demo.id, (tx) => reservedTotal(tx, demo.id));
    worker.beforeFinalize = async () => {
      expect((await h.call('DELETE', D, `/api/v1/files/${s.file.id}`, { cookie: me.session })).statusCode).toBe(204);
    };
    await worker.scanTenant(demo);
    worker.beforeFinalize = null;
    const row = await fileRow(s.file.id);
    expect(row).toMatchObject({ state: 'DELETED', reservedBytes: 0n });
    expect((await storage.readBounded(storage.clean, `tenants/${demo.id}/c/${s.file.id}`, 10_000)).kind).toBe('missing');
    const after = await withTenantTx(h.shard, demo.id, (tx) => reservedTotal(tx, demo.id));
    expect(before - after).toBe(BigInt(bytes.length));
    // A retried job finds nothing to resurrect.
    await worker.scanTenant(demo);
    expect((await fileRow(s.file.id)).state).toBe('DELETED');
  });
});

describe('[FU13] quota cannot be bypassed by concurrency, and releases happen exactly once', () => {
  it('[FU13] parallel slots that together exceed the quota: exactly the ones that fit succeed', async () => {
    // A stepped-up institution admin sets this tenant's quota to (current reservations + 10 000).
    const admin = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
    const restricted = sessionOf(await h.login(D, admin.username));
    const begin = await h.call('POST', D, '/api/v1/auth/mfa/totp/enrol', { cookie: restricted, body: { password: PASSWORD } });
    const secret = base32Decode(begin.json().secret);
    const confirm = await h.call('POST', D, '/api/v1/auth/mfa/totp/confirm', { cookie: restricted, body: { code: totpCode(secret) } });
    await resetReplayGuard(h.shard, demo.id, admin.id);
    const up = sessionOf(await h.call('POST', D, '/api/v1/auth/step-up', { cookie: sessionOf(confirm), body: { password: PASSWORD, code: totpCode(secret) } }));
    await resetReplayGuard(h.shard, demo.id, admin.id);
    const quotaKey = '/api/v1/settings/files.storageQuotaBytes';
    const current = await h.call('GET', D, quotaKey, { cookie: up });
    const base = await withTenantTx(h.shard, demo.id, (tx) => reservedTotal(tx, demo.id));
    const set = (value: number, etag: string) => h.call('PUT', D, quotaKey, { cookie: up, body: { value }, headers: { 'if-match': etag } });
    const put = await set(Number(base) + 10_000, String(current.headers.etag));
    expect(put.statusCode).toBe(200);

    try {
      const me = await student();
      // Deterministic race: hold the first reservation right after it reads the total, until a second
      // request has read too (or 1.5 s pass). With the per-tenant lock the second can't read until the
      // first commits, so it is refused; without the lock both see the same headroom.
      const files = h.app.get(FilesService);
      let calls = 0;
      let secondRead!: () => void;
      const seen = new Promise<void>((r) => (secondRead = r));
      files.afterQuotaRead = async () => {
        if (++calls === 1) await Promise.race([seen, new Promise((r) => setTimeout(r, 1_500))]);
        else secondRead();
      };
      const pair = await Promise.all([slot(me.session, 'race1.pdf', 'application/pdf', 6_000), slot(me.session, 'race2.pdf', 'application/pdf', 6_000)]);
      files.afterQuotaRead = null;
      expect(pair.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      for (const r of pair.filter((x) => x.statusCode === 201)) await h.call('DELETE', D, `/api/v1/files/${(r.json() as Slot).file.id}`, { cookie: me.session });

      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => slot(me.session, `q${String(i)}.pdf`, 'application/pdf', 3_000)));
      const ok = results.filter((r) => r.statusCode === 201);
      expect(ok).toHaveLength(3);
      expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'file.quota_exceeded')).toBe(true);
      const total = await withTenantTx(h.shard, demo.id, (tx) => reservedTotal(tx, demo.id));
      expect(total - base).toBe(9_000n);

      // Release paths, each exactly once: abandon one (cleanup twice), delete one (twice).
      const [a, b] = ok.map((r) => (r.json() as Slot).file.id);
      await forTenant(h.shard, demo.id).fileObject.update({ where: { id: a! }, data: { uploadExpiresAt: new Date(Date.now() - 10 * 60_000) } });
      await worker.cleanup(demo);
      await worker.cleanup(demo);
      await h.call('DELETE', D, `/api/v1/files/${b!}`, { cookie: me.session });
      await h.call('DELETE', D, `/api/v1/files/${b!}`, { cookie: me.session });
      const after = await withTenantTx(h.shard, demo.id, (tx) => reservedTotal(tx, demo.id));
      expect(after - base).toBe(3_000n);
      expect((await fileRow(a!)).state).toBe('ABANDONED');
    } finally {
      const latest = await h.call('GET', D, quotaKey, { cookie: up });
      await h.call('DELETE', D, quotaKey, { cookie: up, headers: { 'if-match': String(latest.headers.etag) } });
    }
  }, 60_000);
});

describe('[FU1][FU2] own files only, with no existence oracle', () => {
  it('[FU2] another user’s file and another tenant’s file are the same 404 as a nonexistent id', async () => {
    const owner = await student();
    const other = await student();
    const poly = await student('poly');
    const s = await upload(owner.session, pdf());
    await scanUntilDone(s.file.id);
    const shape = (r: InjectResult) => {
      const { requestId: _r, ...rest } = r.json() as Record<string, unknown>;
      return JSON.stringify([r.statusCode, rest]);
    };
    const missing = randomUUID();
    for (const [session, host] of [[other.session, D], [poly.session, P]] as const) {
      expect(shape(await view(session, s.file.id, host))).toBe(shape(await view(session, missing, host)));
      expect(shape(await download(session, s.file.id, host))).toBe(shape(await download(session, missing, host)));
      const del = await h.call('DELETE', host, `/api/v1/files/${s.file.id}`, { cookie: session });
      expect(del.statusCode).toBe(404);
    }
    expect((await fileRow(s.file.id)).state).toBe('CLEAN');
    expect((await download(owner.session, s.file.id)).statusCode).toBe(200);
  });

  it('[FU1] objects are private: an anonymous read of the clean object is refused', async () => {
    const me = await student();
    const s = await upload(me.session, pdf());
    await scanUntilDone(s.file.id);
    const res = await fetch(`${process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333'}/uv-clean/tenants/${demo.id}/c/${s.file.id}`);
    expect(res.status).toBe(403);
  });
});
