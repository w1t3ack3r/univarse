// Spec 0031 Q5, Q7, Q16: the chain's verification, on rows in memory. The real chain is append-only and shared with
// development, so tampering is proved here and never against the table.
import type { PlatformClient } from '@univarse/db';
import { describe, expect, it } from 'vitest';
import { walkPlatformAuditChain, writePlatformAudit, type PlatformAuditPages, type PlatformAuditRow, type PlatformChainHead } from './platform-audit.js';

/** A chain built by the real writer, against a fake transaction that keeps rows in an array. */
async function chain(length: number): Promise<PlatformAuditRow[]> {
  const rows: PlatformAuditRow[] = [];
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    platformAuditEvent: {
      findFirst: () => Promise.resolve(rows.at(-1) ?? null),
      create: ({ data }: { data: PlatformAuditRow }) => {
        rows.push(data);
        return Promise.resolve(data);
      },
    },
  };
  for (let i = 0; i < length; i++)
    await writePlatformAudit(tx as unknown as Parameters<Parameters<PlatformClient['$transaction']>[0]>[0], {
      actorId: i % 2 ? '01a1b1d7-4639-720c-baed-d5e2a86521bb' : null,
      action: 'platform.test.event',
      tenantId: null,
      metadata: { n: i, nested: { b: 1, a: 2 } },
      ip: '127.0.0.1',
    });
  return rows;
}

const pagesOf =
  (rows: readonly PlatformAuditRow[], calls: number[] = []): PlatformAuditPages =>
  (afterSeq, limit) => {
    const page = rows.filter((r) => r.seq > afterSeq).slice(0, limit);
    calls.push(page.length);
    return Promise.resolve(page);
  };

const walk = (rows: readonly PlatformAuditRow[], knownHead: PlatformChainHead | null = null) => walkPlatformAuditChain(pagesOf(rows), { pageSize: 3, knownHead });

describe('[0031 Q5] the chain walk', () => {
  it('passes an intact chain, and reports its head', async () => {
    const rows = await chain(10);
    const r = await walk(rows);
    expect(r).toMatchObject({ ok: true, count: 10, head: { seq: 10n } });
    if (r.ok) expect(r.head?.hash).toEqual(rows[9]?.hash);
  });

  it('passes an empty chain, with no head', async () => {
    expect(await walk([])).toEqual({ ok: true, count: 0, head: null });
  });

  it('never asks for more than a page, however long the chain', async () => {
    const rows = await chain(10);
    const calls: number[] = [];
    await walkPlatformAuditChain(pagesOf(rows, calls), { pageSize: 3 });
    expect(Math.max(...calls)).toBe(3);
    expect(calls).toEqual([3, 3, 3, 1]);
  });

  it('finishes when the last page is exactly full', async () => {
    const calls: number[] = [];
    expect(await walkPlatformAuditChain(pagesOf(await chain(6), calls), { pageSize: 3 })).toMatchObject({ ok: true, count: 6 });
    expect(calls).toEqual([3, 3, 0]);
  });

  it('reports its progress by rows checked', async () => {
    const seen: number[] = [];
    await walkPlatformAuditChain(pagesOf(await chain(5)), { pageSize: 2, onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([2, 4, 5]);
  });
});

describe('[0031 Q16] tampering, in memory', () => {
  it('a changed field, in any field the hash covers, is caught at that row', async () => {
    const rows = await chain(5);
    const changes: Partial<PlatformAuditRow>[] = [
      { action: 'platform.test.other' },
      { actorId: '01a1b1d7-0000-720c-baed-d5e2a86521bb' },
      { tenantId: '01a1b1d7-0000-720c-baed-d5e2a86521bb' },
      { ip: '10.0.0.1' },
      { metadata: { n: 2, nested: { b: 1, a: 3 } } },
      { occurredAt: new Date(0) },
    ];
    for (const change of changes) {
      const tampered = rows.map((r) => (r.seq === 3n ? { ...r, ...change } : r));
      expect(await walk(tampered)).toEqual({ ok: false, brokenAtSeq: 3n, reason: 'row_changed', count: 2 });
    }
  });

  it("a row's stored hash replaced is caught at that row", async () => {
    const rows = await chain(5);
    const tampered = rows.map((r) => (r.seq === 3n ? { ...r, hash: new Uint8Array(32).fill(7) } : r));
    expect(await walk(tampered)).toMatchObject({ ok: false, brokenAtSeq: 3n, reason: 'row_changed' });
  });

  it('a deleted row is caught where the sequence breaks', async () => {
    const rows = await chain(5);
    expect(await walk(rows.filter((r) => r.seq !== 3n))).toEqual({ ok: false, brokenAtSeq: 3n, reason: 'row_missing', count: 2 });
  });

  it('a deleted first row is caught', async () => {
    const rows = await chain(3);
    expect(await walk(rows.slice(1))).toMatchObject({ ok: false, brokenAtSeq: 1n, reason: 'row_missing' });
  });

  it('two rows swapped are caught', async () => {
    const [a, b, c] = await chain(3);
    const swapped = [a, { ...c, seq: 2n }, { ...b, seq: 3n }] as PlatformAuditRow[];
    expect(await walk(swapped)).toMatchObject({ ok: false, brokenAtSeq: 2n, reason: 'row_changed' });
  });
});

describe('[0031 Q7] the end of the chain', () => {
  it('rows deleted from the end leave a valid chain: alone, the walk passes', async () => {
    const rows = await chain(6);
    expect(await walk(rows.slice(0, 4))).toMatchObject({ ok: true, count: 4 });
  });

  it('with the last recorded head, the same deletion is caught', async () => {
    const rows = await chain(6);
    const head = { seq: 6n, hash: rows[5]?.hash ?? new Uint8Array() };
    expect(await walk(rows.slice(0, 4), head)).toEqual({ ok: false, brokenAtSeq: 5n, reason: 'tail_missing', count: 4 });
  });

  it('an emptied chain is caught too', async () => {
    const rows = await chain(2);
    expect(await walk([], { seq: 2n, hash: rows[1]?.hash ?? new Uint8Array() })).toMatchObject({ ok: false, reason: 'tail_missing', brokenAtSeq: 1n });
  });

  it('a head that was rewritten is caught, even when the chain is consistent', async () => {
    const rows = await chain(4);
    expect(await walk(rows, { seq: 3n, hash: new Uint8Array(32).fill(9) })).toMatchObject({ ok: false, brokenAtSeq: 3n, reason: 'row_changed' });
  });

  it('a chain that grew past the recorded head passes', async () => {
    const rows = await chain(6);
    expect(await walk(rows, { seq: 4n, hash: rows[3]?.hash ?? new Uint8Array() })).toMatchObject({ ok: true, count: 6, head: { seq: 6n } });
  });
});
