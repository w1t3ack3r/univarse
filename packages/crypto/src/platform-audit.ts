// Platform audit log (spec 0006 E12): one hash chain for platform-level events (key lifecycle now;
// tenant lifecycle and console actions later). Same construction as the tenant chain (spec 0002 A):
// canonical JSON, SHA-256 over prevHash + fields, seq allocated under an advisory lock.
import { createHash } from 'node:crypto';
import type { PlatformClient } from '@univarse/db';

const GENESIS = new Uint8Array(32);
/** Advisory-lock key for the single platform chain (arbitrary constant, platform DB only). */
const CHAIN_LOCK = 0x75766175; // "uvau"

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export interface PlatformAuditEntry {
  /** Platform user id, or null for system actions (seed, jobs). */
  readonly actorId: string | null;
  readonly action: string;
  readonly tenantId: string | null;
  /** Never key material or personal data. */
  readonly metadata: Record<string, unknown>;
  readonly ip?: string | null;
}

type Tx = Parameters<Parameters<PlatformClient['$transaction']>[0]>[0];

function hashOf(prev: Uint8Array, seq: bigint, occurredAt: Date, e: PlatformAuditEntry): Uint8Array<ArrayBuffer> {
  const body = JSON.stringify(
    canonicalize({ v: 1, seq, occurredAt, actorId: e.actorId, action: e.action, tenantId: e.tenantId, metadata: e.metadata, ip: e.ip ?? null }),
  );
  return new Uint8Array(createHash('sha256').update(prev).update(body).digest());
}

/** Appends one event inside the caller's platform transaction (so the change and its audit commit together). */
export async function writePlatformAudit(tx: Tx, entry: PlatformAuditEntry): Promise<bigint> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK})`;
  const last = await tx.platformAuditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
  const seq = (last?.seq ?? 0n) + 1n;
  const prev = last ? new Uint8Array(last.hash) : GENESIS;
  const occurredAt = new Date();
  await tx.platformAuditEvent.create({
    data: {
      seq,
      occurredAt,
      actorId: entry.actorId,
      action: entry.action,
      tenantId: entry.tenantId,
      metadata: canonicalize(entry.metadata) as object,
      ip: entry.ip ?? null,
      prevHash: new Uint8Array(prev),
      hash: hashOf(prev, seq, occurredAt, entry),
    },
  });
  return seq;
}

export type PlatformChainVerification = { ok: true; count: number } | { ok: false; brokenAtSeq: bigint };

export async function verifyPlatformAuditChain(platform: PlatformClient): Promise<PlatformChainVerification> {
  let prev: Uint8Array = GENESIS;
  let expected = 1n;
  const rows = await platform.platformAuditEvent.findMany({ orderBy: { seq: 'asc' } });
  for (const r of rows) {
    const recomputed = hashOf(prev, r.seq, r.occurredAt, {
      actorId: r.actorId,
      action: r.action,
      tenantId: r.tenantId,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      ip: r.ip,
    });
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (r.seq !== expected || !same(new Uint8Array(r.prevHash), prev) || !same(recomputed, new Uint8Array(r.hash))) {
      return { ok: false, brokenAtSeq: r.seq };
    }
    prev = new Uint8Array(r.hash);
    expected += 1n;
  }
  return { ok: true, count: rows.length };
}
