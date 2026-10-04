// Hash-chained, per-tenant audit log (spec 0002 Part A, docs/07 §7).
import { Injectable } from '@nestjs/common';
import type { TenantTx } from '@univarse/db';
import { createHash } from 'node:crypto';
import { canonicalize, canonicalJson } from './canonical.js';
import { redact } from './redact.js';

export type AuditActorType = 'USER' | 'SYSTEM' | 'PLATFORM_STAFF';

export interface AuditEntry {
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

const GENESIS = new Uint8Array(32);
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

/** The exact field set covered by the hash. Changing it is a format change (bump a version first). */
function hashedFields(tenantId: string, seq: bigint, occurredAt: Date, e: StoredFields) {
  return {
    v: 1,
    tenantId,
    seq,
    occurredAt,
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before,
    after: e.after,
    reason: e.reason,
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
  };
}

interface StoredFields {
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function chainHash(prev: Uint8Array, tenantId: string, seq: bigint, occurredAt: Date, e: StoredFields): Uint8Array<ArrayBuffer> {
  return bytes(createHash('sha256').update(prev).update(canonicalJson(hashedFields(tenantId, seq, occurredAt, e))).digest());
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

@Injectable()
export class AuditWriter {
  /**
   * Appends one event inside the caller's transaction (A1). The per-tenant advisory lock serialises
   * appends so the chain never forks (A3); it is released at commit/rollback.
   */
  async write(tx: TenantTx, tenantId: string, entry: AuditEntry): Promise<{ seq: bigint }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`audit:${tenantId}`}, 0))`;
    const last = await tx.auditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
    const seq = (last?.seq ?? 0n) + 1n;
    const prev = last?.hash ?? GENESIS;
    // Store exactly what is hashed: redacted + canonical (dates → ISO strings), so verification
    // after a JSON round-trip recomputes the same bytes.
    const stored: StoredFields = {
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before === undefined ? null : canonicalize(redact(entry.before)),
      after: entry.after === undefined ? null : canonicalize(redact(entry.after)),
      reason: entry.reason ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 512) ?? null,
      requestId: entry.requestId ?? null,
    };
    const occurredAt = new Date();
    const hash = chainHash(prev, tenantId, seq, occurredAt, stored);
    await tx.auditEvent.create({
      data: {
        tenantId,
        seq,
        occurredAt,
        ...stored,
        before: stored.before as never,
        after: stored.after as never,
        prevHash: bytes(Buffer.from(prev)),
        hash,
      },
    });
    return { seq };
  }
}

export type ChainVerification =
  | { ok: true; count: number }
  | { ok: false; brokenAtSeq: bigint; reason: 'seq_gap' | 'prev_hash_mismatch' | 'hash_mismatch' };

/** Recomputes the tenant's whole chain (A5). Run inside a transaction bound to that tenant. */
export async function verifyAuditChain(tx: TenantTx, tenantId: string): Promise<ChainVerification> {
  let expected = 1n;
  let prev: Uint8Array = GENESIS;
  let count = 0;
  for (;;) {
    const rows = await tx.auditEvent.findMany({ where: { seq: { gte: expected } }, orderBy: { seq: 'asc' }, take: 1000 });
    if (rows.length === 0) return { ok: true, count };
    for (const r of rows) {
      if (r.seq !== expected) return { ok: false, brokenAtSeq: expected, reason: 'seq_gap' };
      if (!equalBytes(r.prevHash, prev)) return { ok: false, brokenAtSeq: r.seq, reason: 'prev_hash_mismatch' };
      const recomputed = chainHash(prev, tenantId, r.seq, r.occurredAt, r);
      if (!equalBytes(recomputed, r.hash)) return { ok: false, brokenAtSeq: r.seq, reason: 'hash_mismatch' };
      prev = r.hash;
      expected += 1n;
      count += 1;
    }
  }
}
