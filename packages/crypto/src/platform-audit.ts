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

/** One row as the walk reads it. */
export interface PlatformAuditRow {
  readonly seq: bigint;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly action: string;
  readonly tenantId: string | null;
  readonly metadata: unknown;
  readonly ip: string | null;
  readonly prevHash: Uint8Array;
  readonly hash: Uint8Array;
}

/** The end of the chain as a run saw it: the next run checks it's still there (spec 0031 Q7). */
export interface PlatformChainHead {
  readonly seq: bigint;
  readonly hash: Uint8Array;
}

export type PlatformChainVerification =
  | { ok: true; count: number; head: PlatformChainHead | null }
  | { ok: false; brokenAtSeq: bigint; reason: 'row_changed' | 'row_missing' | 'tail_missing'; count: number };

/** Rows after `afterSeq`, oldest first, at most `limit`. */
export type PlatformAuditPages = (afterSeq: bigint, limit: number) => Promise<readonly PlatformAuditRow[]>;

export const CHAIN_PAGE_SIZE = 1_000;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Spec 0031 Q5, Q7: the whole check, over a page source: pure, so the tests tamper with rows in memory and never with
 * the real, append-only chain (Q16), and one page at a time, so memory stays flat however long the chain is. Given the
 * last recorded head, it also proves the end of the chain is still there, which a chain alone can't: deleting the
 * newest rows leaves a valid chain.
 */
export async function walkPlatformAuditChain(
  pages: PlatformAuditPages,
  opts: { pageSize?: number; knownHead?: PlatformChainHead | null; onProgress?: (count: number) => void } = {},
): Promise<PlatformChainVerification> {
  const pageSize = opts.pageSize ?? CHAIN_PAGE_SIZE;
  const known = opts.knownHead ?? null;
  let prev: Uint8Array = GENESIS;
  let last = 0n;
  let count = 0;
  for (;;) {
    const rows = await pages(last, pageSize);
    for (const r of rows) {
      if (r.seq !== last + 1n) return { ok: false, brokenAtSeq: last + 1n, reason: 'row_missing', count };
      const recomputed = hashOf(prev, r.seq, r.occurredAt, {
        actorId: r.actorId,
        action: r.action,
        tenantId: r.tenantId,
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        ip: r.ip,
      });
      if (!sameBytes(new Uint8Array(r.prevHash), prev) || !sameBytes(recomputed, new Uint8Array(r.hash))) return { ok: false, brokenAtSeq: r.seq, reason: 'row_changed', count };
      if (known?.seq === r.seq && !sameBytes(new Uint8Array(r.hash), new Uint8Array(known.hash))) return { ok: false, brokenAtSeq: r.seq, reason: 'row_changed', count };
      prev = new Uint8Array(r.hash);
      last = r.seq;
      count += 1;
    }
    opts.onProgress?.(count);
    if (rows.length < pageSize) break;
  }
  if (known && last < known.seq) return { ok: false, brokenAtSeq: last + 1n, reason: 'tail_missing', count };
  return { ok: true, count, head: last === 0n ? null : { seq: last, hash: prev } };
}

/** The chain's rows, a page at a time, from any client that can read it. */
export const platformAuditPages =
  (platform: Pick<PlatformClient, 'platformAuditEvent'>): PlatformAuditPages =>
  (afterSeq, limit) =>
    platform.platformAuditEvent.findMany({ where: { seq: { gt: afterSeq } }, orderBy: { seq: 'asc' }, take: limit });

export const verifyPlatformAuditChain = (platform: PlatformClient, knownHead: PlatformChainHead | null = null): Promise<PlatformChainVerification> =>
  walkPlatformAuditChain(platformAuditPages(platform), { knownHead });
