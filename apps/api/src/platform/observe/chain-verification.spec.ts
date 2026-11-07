// Spec 0031 Q6, Q10: a verification's outcomes that the real chain can't show: a broken chain, a run that can't finish,
// one run at a time. Rows live in memory here; the real chain is never tampered with (Q16).
import { Logger } from '@nestjs/common';
import { writePlatformAudit, type PlatformAuditRow } from '@univarse/crypto';
import type { PlatformClient } from '@univarse/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformActor } from '../identity/types.js';
import type { PlatformConfig } from '../platform-config.js';
import { ChainVerification, VERIFY_EVERY_MS } from './chain-verification.js';

const config = { AUDIT_VERIFY_CHECK_INTERVAL_MS: 0 } as PlatformConfig;
const actor = { userId: '01a1b1d7-4639-720c-baed-d5e2a86521bb' } as PlatformActor;

interface RunRow extends Record<string, unknown> {
  id: string;
  status: string;
  startedAt: Date;
}

/** Just enough of the client, over arrays. `rows` is the chain; `fail` makes the page read throw. */
function fakeDb(rows: PlatformAuditRow[], opts: { fail?: boolean; hold?: Promise<void> } = {}) {
  const runs: RunRow[] = [];
  const audit: { action: string; metadata: unknown }[] = [];
  const auditTable = {
    findFirst: () => Promise.resolve(rows.at(-1) ?? null),
    create: ({ data }: { data: PlatformAuditRow & { action: string; metadata: unknown } }) => {
      audit.push(data);
      return Promise.resolve(data);
    },
    findMany: async ({ where, take }: { where: { seq: { gt: bigint } }; take: number }) => {
      await opts.hold;
      if (opts.fail) throw Object.assign(new Error('down'), { code: 'P2028' });
      return rows.filter((r) => r.seq > where.seq.gt).slice(0, take);
    },
  };
  const runTable = {
    updateMany: ({ where, data }: { where: { status: string }; data: Record<string, unknown> }) => {
      for (const r of runs) if (r.status === where.status) Object.assign(r, data);
      return Promise.resolve({ count: 0 });
    },
    create: ({ data }: { data: Record<string, unknown> }) => {
      const run = { id: `run-${String(runs.length + 1)}`, status: 'RUNNING', startedAt: new Date(), rowsChecked: 0n, finishedAt: null, headSeq: null, brokenAtSeq: null, reason: null, ...data };
      runs.push(run);
      return Promise.resolve(run);
    },
    update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const run = runs.find((r) => r.id === where.id);
      if (run) Object.assign(run, data);
      return Promise.resolve(run);
    },
    findFirst: ({ where }: { where: { status: string | { in: string[] } } }) => {
      const wanted = typeof where.status === 'string' ? [where.status] : where.status.in;
      return Promise.resolve([...runs].reverse().find((r) => wanted.includes(r.status)) ?? null);
    },
    findMany: () => Promise.resolve([...runs].reverse()),
  };
  const client = { platformAuditEvent: auditTable, platformAuditVerification: runTable, $executeRaw: () => Promise.resolve(0), $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client) };
  return { db: client as unknown as PlatformClient, runs, audit };
}

async function chainOf(length: number): Promise<PlatformAuditRow[]> {
  const rows: PlatformAuditRow[] = [];
  const { db } = fakeDb(rows);
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    platformAuditEvent: {
      ...(db as unknown as { platformAuditEvent: object }).platformAuditEvent,
      create: ({ data }: { data: PlatformAuditRow }) => {
        rows.push(data);
        return Promise.resolve(data);
      },
    },
  };
  for (let i = 0; i < length; i++) await writePlatformAudit(tx as never, { actorId: null, action: 'platform.test.event', tenantId: null, metadata: { i } });
  return rows;
}

afterEach(() => vi.restoreAllMocks());

describe('[0031 Q6] a broken chain', () => {
  it('fails the run, logs the security event, audits it, and shows until a later run passes', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rows = await chainOf(4);
    const { db, runs, audit } = fakeDb(rows.map((r) => (r.seq === 2n ? { ...r, action: 'platform.test.forged' } : r)));
    const verify = new ChainVerification(db, config);
    await verify.start(actor);
    await verify.finished();
    expect(runs[0]).toMatchObject({ status: 'FAILED', brokenAtSeq: 2n, reason: 'row_changed' });
    expect(error.mock.calls[0]?.[0]).toMatchObject({ event: 'platform.audit.chain_broken', stream: 'security', brokenAtSeq: '2' });
    expect(audit.at(-1)).toMatchObject({ action: 'platform.audit.verified', metadata: { result: 'failed', reason: 'row_changed' } });
    expect((await verify.recent()).broken).toBe(true);
  });

  it('a chain that changes nothing else: the failed run touches no audit row', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rows = await chainOf(3);
    const tampered = rows.map((r) => (r.seq === 2n ? { ...r, action: 'platform.test.forged' } : r));
    const before = JSON.stringify(tampered.map((r) => r.action));
    const { db } = fakeDb(tampered);
    const verify = new ChainVerification(db, config);
    await verify.start(null);
    await verify.finished();
    expect(JSON.stringify(tampered.map((r) => r.action))).toBe(before);
  });

  it('rows deleted from the end, after a passing run, fail the next one', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const rows = await chainOf(5);
    const live = [...rows];
    const { db, runs } = fakeDb(live);
    const verify = new ChainVerification(db, config);
    await verify.start(null);
    await verify.finished();
    expect(runs[0]).toMatchObject({ status: 'PASSED', headSeq: 5n });
    live.splice(3);
    await verify.start(null);
    await verify.finished();
    expect(runs[1]).toMatchObject({ status: 'FAILED', reason: 'tail_missing', brokenAtSeq: 4n });
  });
});

describe('[0031 Q6, Q10] a run that can\'t finish', () => {
  it('is ERROR, says nothing about the chain, and never rejects unhandled', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { db, runs } = fakeDb(await chainOf(2), { fail: true });
    const verify = new ChainVerification(db, config);
    await verify.start(null);
    await verify.finished();
    await new Promise((r) => setTimeout(r, 5));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({ status: 'ERROR', reason: 'could_not_finish' });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'platform.audit.verification_failed', reason: 'P2028' });
    expect((await verify.recent()).broken).toBe(false);
  });

  it('a run a dead process left RUNNING is closed by the next start', async () => {
    const { db, runs } = fakeDb(await chainOf(1));
    const verify = new ChainVerification(db, config);
    runs.push({ id: 'stale', status: 'RUNNING', startedAt: new Date(0) });
    await verify.start(null);
    await verify.finished();
    expect(runs.find((r) => r.id === 'stale')).toMatchObject({ status: 'ERROR', reason: 'interrupted' });
  });
});

describe('[0031 Q6] one run at a time', () => {
  it('a second start is refused while one runs, and the schedule stays out of its way', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((r) => (release = r));
    const { db, runs } = fakeDb(await chainOf(2), { hold });
    const verify = new ChainVerification(db, config);
    await verify.start(actor);
    await expect(verify.start(actor)).rejects.toMatchObject({ status: 409, code: 'audit.verification_running' });
    await verify.startIfDue(new Date(Date.now() + VERIFY_EVERY_MS * 2));
    expect(runs).toHaveLength(1);
    release();
    await verify.finished();
    await expect(verify.start(actor)).resolves.toBeTruthy();
    await verify.finished();
  });

  it('shutting down waits for the run', async () => {
    const { db, runs } = fakeDb(await chainOf(2));
    const verify = new ChainVerification(db, config);
    await verify.start(null);
    await verify.onApplicationShutdown();
    expect(runs[0]?.status).toBe('PASSED');
  });
});
