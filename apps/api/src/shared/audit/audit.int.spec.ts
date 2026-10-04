/**
 * Spec 0002 Part A — hash-chained audit log. Every AC ID appears in a test name.
 * Each test uses a fresh random tenant id, so every chain is independent of other tests and runs.
 */
import { randomUUID } from 'node:crypto';
import { createTenantShardClient, withTenantTx, type TenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../testing/int-harness.js';
import { AuditWriter, verifyAuditChain, type AuditEntry } from './audit-writer.js';

let h: Harness;
let writer: AuditWriter;
let owner: TenantShardClient; // schema owner (migrator): simulates an insider with DB access

const entry = (i: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  actorType: 'SYSTEM',
  actorId: null,
  action: 'test.audit.event',
  entityType: 'test',
  entityId: null,
  after: { i, at: new Date('2026-10-04T12:00:00Z') },
  requestId: `req-${i}`,
  ...extra,
});

const appendN = async (tenantId: string, n: number) => {
  for (let i = 1; i <= n; i++) await withTenantTx(h.shard, tenantId, (tx) => writer.write(tx, tenantId, entry(i)));
};
const verify = (tenantId: string) => withTenantTx(h.shard, tenantId, (tx) => verifyAuditChain(tx, tenantId));
/** Insider tampering: raw SQL as the table owner, inside the tenant's RLS context (FORCE applies to owners too). */
const tamper = (tenantId: string, sql: string) =>
  withTenantTx(owner, tenantId, (tx) => tx.$executeRawUnsafe(sql));

beforeAll(async () => {
  h = await createHarness();
  writer = h.app.get(AuditWriter);
  owner = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
});
afterAll(async () => {
  await owner.$disconnect();
  await h.close();
});

describe('hash-chained audit log (spec 0002 Part A)', () => {
  it('[A2] events get seq 1..n with a valid chain from the genesis hash', async () => {
    const t = randomUUID();
    await appendN(t, 5);
    const rows = await withTenantTx(h.shard, t, (tx) => tx.auditEvent.findMany({ orderBy: { seq: 'asc' } }));
    expect(rows.map((r) => r.seq)).toEqual([1n, 2n, 3n, 4n, 5n]);
    expect(Buffer.from(rows[0]!.prevHash).equals(Buffer.alloc(32))).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(Buffer.from(rows[i]!.prevHash).equals(Buffer.from(rows[i - 1]!.hash))).toBe(true);
    expect(await verify(t)).toEqual({ ok: true, count: 5 });
  });

  it('[A1] if the business transaction rolls back, its audit event is gone too', async () => {
    const t = randomUUID();
    await appendN(t, 1);
    await expect(
      withTenantTx(h.shard, t, async (tx) => {
        await writer.write(tx, t, entry(2));
        throw new Error('business failure after audit write');
      }),
    ).rejects.toThrow('business failure');
    expect(await verify(t)).toEqual({ ok: true, count: 1 });
    // …and the next append continues the chain without a gap.
    await appendN(t, 1);
    expect(await verify(t)).toEqual({ ok: true, count: 2 });
  });

  it('[A3] parallel appends in one tenant never fork the chain', async () => {
    const t = randomUUID();
    await Promise.all(Array.from({ length: 12 }, (_, i) => withTenantTx(h.shard, t, (tx) => writer.write(tx, t, entry(i + 1)))));
    expect(await verify(t)).toEqual({ ok: true, count: 12 });
  });

  it('[A3] an open append in tenant A does not block appends in tenant B', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slowA = withTenantTx(
      h.shard,
      a,
      async (tx) => {
        await writer.write(tx, a, entry(1)); // holds A's advisory lock until commit
        await held;
      },
      { timeoutMs: 15_000 },
    );
    const t0 = performance.now();
    await withTenantTx(h.shard, b, (tx) => writer.write(tx, b, entry(1)));
    expect(performance.now() - t0).toBeLessThan(2_000);
    release();
    await slowA;
    expect(await verify(a)).toEqual({ ok: true, count: 1 });
  });

  it('[A4] the app role cannot update, delete or truncate audit events', async () => {
    const t = randomUUID();
    await appendN(t, 1);
    for (const sql of ['UPDATE audit_event SET action = $$x$$', 'DELETE FROM audit_event', 'TRUNCATE audit_event']) {
      await expect(withTenantTx(h.shard, t, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('[A5] detects a modified field', async () => {
    const t = randomUUID();
    await appendN(t, 4);
    await tamper(t, `UPDATE audit_event SET action = 'auth.mfa.disabled' WHERE seq = 3`);
    expect(await verify(t)).toEqual({ ok: false, brokenAtSeq: 3n, reason: 'hash_mismatch' });
  });

  it('[A5] detects a modified JSON payload', async () => {
    const t = randomUUID();
    await appendN(t, 3);
    await tamper(t, `UPDATE audit_event SET after = jsonb_set(after, '{i}', '99') WHERE seq = 2`);
    expect(await verify(t)).toEqual({ ok: false, brokenAtSeq: 2n, reason: 'hash_mismatch' });
  });

  it('[A5] detects a deleted event', async () => {
    const t = randomUUID();
    await appendN(t, 4);
    await tamper(t, `DELETE FROM audit_event WHERE seq = 2`);
    expect(await verify(t)).toEqual({ ok: false, brokenAtSeq: 2n, reason: 'seq_gap' });
  });

  it('[A5] detects an inserted event (later events shifted to make room)', async () => {
    const t = randomUUID();
    await appendN(t, 3);
    await tamper(t, `UPDATE audit_event SET seq = seq + 10 WHERE seq >= 2`);
    await tamper(t, `UPDATE audit_event SET seq = seq - 9 WHERE seq >= 12`); // 2→3, 3→4: gap at 2 filled below
    await tamper(
      t,
      `INSERT INTO audit_event (id, tenant_id, seq, occurred_at, actor_type, action, entity_type, prev_hash, hash)
       SELECT uuidv7(), tenant_id, 2, now(), 'SYSTEM', 'forged.event', 'test', hash, hash FROM audit_event WHERE seq = 1`,
    );
    const result = await verify(t);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.brokenAtSeq).toBe(2n);
  });

  it('[A5] detects reordered events', async () => {
    const t = randomUUID();
    await appendN(t, 4);
    // Swap seq 2 and 3 via a temporary value (the unique index is checked per row).
    await tamper(t, `UPDATE audit_event SET seq = 1000 WHERE seq = 2`);
    await tamper(t, `UPDATE audit_event SET seq = 2 WHERE seq = 3`);
    await tamper(t, `UPDATE audit_event SET seq = 3 WHERE seq = 1000`);
    const result = await verify(t);
    expect(result).toMatchObject({ ok: false, brokenAtSeq: 2n });
  });

  it('[A8] chains are per tenant: one tenant never sees or verifies another tenant’s events', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await appendN(a, 3);
    await appendN(b, 2);
    expect(await verify(a)).toEqual({ ok: true, count: 3 });
    expect(await verify(b)).toEqual({ ok: true, count: 2 });
    const seenByB = await withTenantTx(h.shard, b, (tx) => tx.auditEvent.findMany({ select: { tenantId: true } }));
    expect(seenByB.every((r) => r.tenantId === b)).toBe(true);
  });

  it('[A6] secrets in before/after are redacted before hashing and storage', async () => {
    const t = randomUUID();
    await withTenantTx(h.shard, t, (tx) =>
      writer.write(tx, t, entry(1, { before: { password: 'hunter2', status: 'ACTIVE' }, after: { code: '123456', recoveryCodes: ['A'] } })),
    );
    const row = await withTenantTx(h.shard, t, (tx) => tx.auditEvent.findFirstOrThrow());
    expect(JSON.stringify([row.before, row.after])).not.toMatch(/hunter2|123456/);
    expect(row.before).toEqual({ password: '[REDACTED]', status: 'ACTIVE' });
    expect(await verify(t)).toEqual({ ok: true, count: 1 });
  });
});
