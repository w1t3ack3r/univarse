/**
 * Spec 0014 (cross-tenant suite, layer 4): the file-scan worker processes only the tenant of the pass.
 * Real SeaweedFS and real ClamAV (clean PDFs only). Prereqs: `pnpm dev:infra` (seaweedfs, clamav),
 * `pnpm db:migrate && pnpm db:seed`.
 *
 * Two spies on the worker's own instances, both passing calls through:
 *  • ShardRegistry.tx / forTenant: the tenant id of every tenant-context call;
 *  • FileStorage.put / remove / listKeys / readBounded: every object key touched, with the log context's
 *    tenant at that moment (spec 0012 OB2).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { forTenant, withTenantTx } from '@univarse/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShardRegistry } from '../../shared/db/db.module.js';
import { currentLogContext } from '../../shared/observability/context.js';
import {
  createHarness,
  HOSTS,
  type Harness,
  type InjectResult,
} from '../../testing/int-harness.js';
import { claimDue, FileScanWorker, SCAN_BATCH } from './file-scan.worker.js';
import { FileStorage } from './file-storage.js';
import { quarantineKey } from './files.service.js';

type T = 'demo' | 'poly';
let h: Harness;
let worker: FileScanWorker;
let storage: FileStorage;
const ref: Record<T, { id: string; shardId: string }> = {} as never;
/** Tenant ids of every tenant-context call the worker made. */
const contextCalls: string[] = [];
/** Every object the worker touched: key, and the log context's tenant at the time. */
const touched: { op: string; key: string; logTenant: string | null | undefined }[] = [];
const reset = () => {
  contextCalls.length = 0;
  touched.length = 0;
};

const pdf = () => Buffer.from(`%PDF-1.4\n% isolation ${randomBytes(6).toString('hex')}\n%%EOF\n`);
const sessionOf = (res: InjectResult): string => {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [String(raw)] : []).map((c) => c.split(';')[0]!);
  return all.find((c) => c.startsWith('__Host-uv_sid=') && c.length > 20)!;
};

/** A student of `tenant` uploads a clean PDF through the real API and storage; the file is then UPLOADED. */
async function uploaded(tenant: T): Promise<string> {
  const host = HOSTS[tenant];
  const u = await h.makeUser(tenant, { role: 'STUDENT' });
  const session = sessionOf(await h.login(host, u.username));
  const bytes = pdf();
  const res = await h.call('POST', host, '/api/v1/files/uploads', {
    cookie: session,
    body: { name: 'iso.pdf', mime: 'application/pdf', sizeBytes: bytes.length },
  });
  expect(res.statusCode, res.body).toBe(201);
  const s = res.json() as {
    file: { id: string };
    upload: { url: string; fields: Record<string, string> };
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(s.upload.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'upload');
  expect((await fetch(s.upload.url, { method: 'POST', body: form })).status).toBeLessThan(300);
  expect(
    (await h.call('POST', host, `/api/v1/files/${s.file.id}/complete`, { cookie: session }))
      .statusCode,
  ).toBe(200);
  return s.file.id;
}

const row = (tenant: T, id: string) =>
  forTenant(h.shard, ref[tenant].id).fileObject.findUniqueOrThrow({ where: { id } });

/**
 * Scan passes for `tenant` until it has nothing due (other suites' leftovers included). `check`: assert the
 * spies per pass; setup only quiets the worker, so a broken worker fails the intended test, not the setup.
 */
async function drain(tenant: T, { check = true }: { check?: boolean } = {}): Promise<void> {
  for (let i = 0; i < 20; i++) {
    reset();
    const outcomes = await worker.scanTenant(ref[tenant]);
    if (check) assertOnly(tenant);
    if (outcomes.length < SCAN_BATCH) return;
  }
}

/**
 * Every tenant-context call and every object touched since the last reset belongs to `tenant`. `log`: also
 * require the log context to name it (the production pass sets it per tenant; a direct `cleanup` call doesn't).
 */
function assertOnly(tenant: T, { log = true }: { log?: boolean } = {}): void {
  const id = ref[tenant].id;
  expect(new Set(contextCalls), `tenant-context calls of ${tenant}'s pass`).toEqual(
    contextCalls.length ? new Set([id]) : new Set(),
  );
  for (const t of touched) {
    expect(
      t.key.startsWith(`tenants/${id}/`),
      `${t.op} ${t.key} lies under ${tenant}'s prefix`,
    ).toBe(true);
    if (log) expect(t.logTenant, `log context during ${t.op} ${t.key}`).toBe(id);
  }
}

beforeAll(async () => {
  h = await createHarness();
  worker = h.workerCtx.get(FileScanWorker);
  storage = h.workerCtx.get(FileStorage);
  for (const t of ['demo', 'poly'] as const) {
    ref[t] = {
      id: h.tenants[t],
      shardId: (await h.platform.tenant.findUniqueOrThrow({ where: { id: h.tenants[t] } })).shardId,
    };
  }
  const registry = h.workerCtx.get(ShardRegistry);
  const tx = registry.tx.bind(registry);
  const ft = registry.forTenant.bind(registry);
  registry.tx = (s: string, t: string, fn: never, o?: never) => (
    contextCalls.push(t),
    tx(s, t, fn, o)
  );
  registry.forTenant = (s: string, t: string) => (contextCalls.push(t), ft(s, t));
  for (const op of ['put', 'remove', 'listKeys', 'readBounded'] as const) {
    const original = (storage[op] as (...a: unknown[]) => unknown).bind(storage);
    (storage as unknown as Record<string, unknown>)[op] = (
      bucket: string,
      key: string,
      ...rest: unknown[]
    ) => {
      touched.push({ op, key, logTenant: currentLogContext()?.tenantId });
      return original(bucket, key, ...rest);
    };
  }
  // Start from a quiet worker: nothing already due for either tenant.
  await drain('demo', { check: false });
  await drain('poly', { check: false });
}, 120_000);

afterAll(async () => {
  await h.close();
});

beforeEach(reset);

describe('[JI1][JI2] the file scan claims and processes only the tenant of the pass', () => {
  it("[JI1][JI8] a pass for demo finishes only demo's upload; poly's waits untouched, then a poly pass finishes it", async () => {
    const mine = await uploaded('demo');
    const theirs = await uploaded('poly');
    const theirsBefore = await row('poly', theirs);

    reset();
    const outcomes = await worker.scanTenant(ref.demo);
    expect(outcomes).toEqual(['clean']);
    assertOnly('demo');
    expect((await row('demo', mine)).state).toBe('CLEAN');
    const theirsAfter = await row('poly', theirs);
    expect({
      state: theirsAfter.state,
      lease: theirsAfter.leaseToken,
      attempts: theirsAfter.scanAttempts,
      updatedAt: theirsAfter.updatedAt,
    }).toEqual({
      state: 'UPLOADED',
      lease: null,
      attempts: theirsBefore.scanAttempts,
      updatedAt: theirsBefore.updatedAt,
    });

    reset();
    expect(await worker.scanTenant(ref.poly)).toEqual(['clean']);
    assertOnly('poly');
    expect((await row('poly', theirs)).state).toBe('CLEAN');
  });

  it('[JI2][JI8] each result is attributed to its own tenant: audit rows, clean objects, and the log context during its storage calls', async () => {
    const files = { demo: await uploaded('demo'), poly: await uploaded('poly') };
    for (const t of ['demo', 'poly'] as const) {
      reset();
      expect(await worker.scanTenant(ref[t])).toEqual(['clean']);
      assertOnly(t); // includes: the clean object was written under t's prefix, with t's log context
      expect(
        touched.some(
          (x) => x.op === 'put' && x.key.startsWith(`tenants/${ref[t].id}/c/${files[t]}/`),
        ),
      ).toBe(true);
    }
    for (const t of ['demo', 'poly'] as const) {
      const f = await row(t, files[t]);
      expect(f.cleanKey?.startsWith(`tenants/${ref[t].id}/c/${files[t]}/`)).toBe(true);
      const rows = await withTenantTx(
        h.shard,
        ref[t].id,
        (tx) =>
          tx.$queryRaw<
            { tenant_id: string; action: string }[]
          >`SELECT tenant_id::text, action FROM audit_event WHERE entity_type = 'file_object' AND entity_id = ${files[t]}::uuid`,
      );
      expect(rows.map((r) => r.action)).toContain('files.scan.clean');
      expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([ref[t].id]));
      // And from the other tenant's context the file's audit rows don't exist at all.
      const other = t === 'demo' ? 'poly' : 'demo';
      const leaked = await withTenantTx(
        h.shard,
        ref[other].id,
        (tx) =>
          tx.$queryRaw<
            { n: bigint }[]
          >`SELECT count(*) AS n FROM audit_event WHERE entity_id = ${files[t]}::uuid`,
      );
      expect(Number(leaked[0]!.n)).toBe(0);
    }
  });
});

describe('[JI2] the production pass (runOnce) attributes every object it touches to that object’s tenant', () => {
  it('[JI2][JI8] across both tenants, each storage operation runs under the log context of the tenant whose prefix it touches', async () => {
    await uploaded('demo');
    await uploaded('poly');
    const orphan = quarantineKey(ref.poly.id, randomUUID()); // so the cleanup half touches storage too
    await storage.put(storage.quarantine, orphan, pdf(), 'application/pdf');
    reset();
    const totals = await worker.runOnce();
    expect(totals.clean).toBeGreaterThanOrEqual(2);
    expect(touched.length).toBeGreaterThan(0);
    for (const t of touched) {
      const prefixTenant = /^tenants\/([0-9a-f-]{36})\//.exec(t.key)?.[1];
      expect(prefixTenant, `${t.op} ${t.key} is under a tenant prefix`).toBeDefined();
      expect(
        t.logTenant,
        `${t.op} ${t.key}: the log context names the tenant whose object it is`,
      ).toBe(prefixTenant);
    }
    expect(
      touched.some((t) => t.key === orphan && t.op === 'remove' && t.logTenant === ref.poly.id),
    ).toBe(true);
    expect(new Set(contextCalls).size).toBeGreaterThanOrEqual(2); // both tenants were passed over
    for (const c of contextCalls) expect(typeof c === 'string' && c.length === 36).toBe(true);
  });
});

describe('[JI3] cleanup stays in its tenant', () => {
  it("[JI3][JI8] demo's cleanup never removes poly's orphan or dead objects; poly's own cleanup does", async () => {
    // Poly: an orphan quarantine object (no record), and a dead file whose quarantine object remains.
    const orphanKey = quarantineKey(ref.poly.id, randomUUID());
    await storage.put(storage.quarantine, orphanKey, pdf(), 'application/pdf');
    const dead = await uploaded('poly');
    await forTenant(h.shard, ref.poly.id).fileObject.update({
      where: { id: dead },
      data: { state: 'DELETED', reservedBytes: 0, deletedAt: new Date() },
    }); // as a real delete leaves it (constraint file_object_deleted_released)
    const deadKey = (await row('poly', dead)).quarantineKey!;
    expect(deadKey).toBe(quarantineKey(ref.poly.id, dead));

    reset();
    await worker.cleanup(ref.demo);
    assertOnly('demo', { log: false }); // log attribution of cleanup: the production-pass test below
    expect((await storage.readBounded(storage.quarantine, orphanKey, 10_000)).kind).toBe('ok');
    expect((await storage.readBounded(storage.quarantine, deadKey, 10_000)).kind).toBe('ok');
    expect((await row('poly', dead)).quarantineKey).toBe(deadKey);

    reset();
    const done = await worker.cleanup(ref.poly);
    assertOnly('poly', { log: false });
    expect(done.orphans).toBeGreaterThanOrEqual(1);
    expect((await storage.readBounded(storage.quarantine, orphanKey, 10_000)).kind).toBe('missing');
    expect((await storage.readBounded(storage.quarantine, deadKey, 10_000)).kind).toBe('missing');
    expect((await row('poly', dead)).quarantineKey).toBeNull();
  });
});

describe('[JI4] RLS is the backstop for the claim', () => {
  it("[JI4][JI8] under demo's context poly's files are invisible, and the production claim with poly's id claims nothing; under poly's context it claims", async () => {
    const theirs = await uploaded('poly');
    const token = randomUUID();
    // The mutant: the worker's own claim (claimDue), with the OTHER tenant's id, under demo's database context.
    const seen = await withTenantTx(h.shard, ref.demo.id, async (tx) => {
      const visible = await tx.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM file_object WHERE tenant_id = ${ref.poly.id}::uuid`;
      const claimed = await claimDue(tx, ref.poly.id, token);
      return { visible: Number(visible[0]!.n), claimed: claimed.length };
    });
    expect(seen).toEqual({ visible: 0, claimed: 0 });
    expect((await row('poly', theirs)).state).toBe('UPLOADED');

    // The control: the SAME production claim under poly's own context claims poly's file.
    const own = await withTenantTx(h.shard, ref.poly.id, (tx) => claimDue(tx, ref.poly.id, token));
    expect(own.map((r) => r.id)).toContain(theirs);
    expect(own.every((r) => r.lease_token === token)).toBe(true);
    expect((await row('poly', theirs)).state).toBe('SCANNING');

    // Leave everything it claimed scannable again, then let poly's worker finish it.
    await forTenant(h.shard, ref.poly.id).fileObject.updateMany({
      where: { id: { in: own.map((r) => r.id) }, leaseToken: token },
      data: { state: 'UPLOADED', leaseToken: null, leaseUntil: null },
    });
    await drain('poly');
    expect((await row('poly', theirs)).state).toBe('CLEAN');
  });
});
