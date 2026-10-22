// Spec 0020 D7, D8, D13: the destruction protocol and its recovery, stopped at every point (BK11), against the
// in-memory database model (fake-keys-db.ts; the integration test runs the real CLI). "Total stack loss" replaces the
// database with an older backup's state; the durable ledger is kept, and the bucket is never read.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destinationsOf, opStates, type Destination } from './chain.js';
import { init } from './commands.js';
import { FakeKeysDb } from './fake-keys-db.js';
import { establishAuthority } from './ledger.js';
import { abandon, destroy, recover, type ProtocolDeps } from './protocol.js';
import { copyDir, entriesOf, readCopy, realFs, type LedgerFs } from './store.js';

const T1 = '10000000-0000-4000-8000-000000000001'; // offboarded: every key destroyed
const T2 = '10000000-0000-4000-8000-000000000002'; // a retired version, eligible
const T3 = '10000000-0000-4000-8000-000000000003'; // destroyed earlier: an accepted destruction

class Crash extends Error {}

let root: string;
let primary: Destination;
let externalPath: string;
let db: FakeKeysDb;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-protocol-'));
  primary = { id: 'primary', path: join(root, 'primary') };
  externalPath = join(root, 'external');
  db = new FakeKeysDb();
  db.addTenant(T1, 't1', { 1: 'RETIRED', 2: 'ACTIVE' });
  db.addTenant(T2, 't2', { 1: 'RETIRED', 2: 'ACTIVE' }, [1]);
  db.addTenant(T3, 't3', { 1: 'ACTIVE' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(over: Partial<ProtocolDeps> = {}): ProtocolDeps {
  return { primary, db, lock: () => Promise.resolve({ release: () => undefined }), log: () => undefined, ...over };
}
const entries = () => {
  const a = establishAuthority(primary);
  if (!a.ok) throw new Error(a.problems.join('\n'));
  return a.entries;
};
const outcomeOf = (op: string) => opStates(entries()).ops.get(op)?.outcome?.type ?? 'pending';

async function ready(): Promise<string> {
  expect((await init(deps(), [externalPath])).ok).toBe(true);
  const r = await destroy(deps(), { slug: 't3' });
  expect(r.ok).toBe(true);
  return r.op ?? '';
}

describe('[BK1] the protocol', () => {
  it('[BK1] pending is durable everywhere before the database, committed everywhere before success', async () => {
    await ready();
    const order: string[] = [];
    const watched = Object.assign(Object.create(db) as FakeKeysDb, {
      destroy: (op: string, slug: string, v?: number) => {
        order.push('DB');
        return db.destroy(op, slug, v);
      },
    });
    const r = await destroy(deps({ crash: (p) => void order.push(p), db: watched }), { slug: 't1' });
    expect(r.ok).toBe(true);
    expect(order.map((p) => p.replace(/dest-[0-9a-f]+/, 'dest'))).toEqual(['pending:primary', 'pending:dest', 'db:before', 'DB', 'db:after', 'committed:primary', 'committed:dest', 'report:before']);
    expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED', 2: 'DESTROYED' });
    expect(outcomeOf(r.op ?? '')).toBe('committed');
  });

  it('[BK1] a refused precondition: nothing is written when the read-only check refuses; aborted when the transaction does', async () => {
    await ready();
    const before = entries().length;
    expect((await destroy(deps(), { slug: 't2', version: 2 })).lines.join()).toMatch(/refused before anything was written: not_retired/);
    expect(entries()).toHaveLength(before);
    // Passes the check, then refused inside the transaction (it became ineligible in between).
    const racing: ProtocolDeps = deps({ db: Object.assign(Object.create(db) as FakeKeysDb, { check: async (s: string, v?: number) => { const c = await db.check(s, v); db.setKey(T2, 1, { eligible: false }); return c; } }) });
    const r = await destroy(racing, { slug: 't2', version: 1 });
    expect(r.lines.join()).toMatch(/refused by the database, nothing destroyed: sweep_pending \(recorded as aborted\)/);
    expect(outcomeOf(r.op ?? '')).toBe('aborted');
    expect(db.keysOf(T2)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
  });

  it('[BK1][A2-8] an unknown outcome is never aborted: it stays pending, and recovery settles it from the evidence', async () => {
    await ready();
    db.fault = 'commit-then-lost';
    const r = await destroy(deps(), { slug: 't1' });
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/outcome is unknown .* pending, not accepted/);
    expect(outcomeOf(r.op ?? '')).toBe('pending');
    expect((await recover(deps())).ok).toBe(true);
    expect(outcomeOf(r.op ?? '')).toBe('committed');
    expect(db.calls.filter((c) => c === `destroy:${r.op ?? ''}`)).toHaveLength(1); // read from the evidence, not redone
  });

  it('[BK1] the bucket gets a copy of every entry, and is never read', async () => {
    await ready();
    expect(db.bucket.map((e) => e.seq)).toEqual(entries().map((e) => e.seq));
  });
});

/** Every point the protocol can stop at, as named by its crash hook (D13). */
async function crashPoints(): Promise<string[]> {
  const points: string[] = [];
  await ready();
  await destroy(deps({ crash: (p) => void points.push(p) }), { slug: 't1' });
  return points;
}

describe('[BK11] crash injection, with and without total stack loss', async () => {
  const setupRoot = mkdtempSync(join(tmpdir(), 'uv-points-'));
  const savedRoot = root;
  root = setupRoot;
  primary = { id: 'primary', path: join(root, 'primary') };
  externalPath = join(root, 'external');
  db = new FakeKeysDb();
  db.addTenant(T1, 't1', { 1: 'RETIRED', 2: 'ACTIVE' });
  db.addTenant(T3, 't3', { 1: 'ACTIVE' });
  const points = await crashPoints();
  rmSync(setupRoot, { recursive: true, force: true });
  root = savedRoot;

  it('[D13] the points are every destination write of each record, both sides of the transaction, and the report', () => {
    expect(points.map((p) => p.replace(/dest-[0-9a-f]+/, 'dest'))).toEqual(['pending:primary', 'pending:dest', 'db:before', 'db:after', 'committed:primary', 'committed:dest', 'report:before']);
  });

  for (const point of points)
    for (const loss of [false, true])
      it(`[BK11] stopped at ${point.replace(/dest-[0-9a-f]+/, 'dest')}${loss ? ', then total stack loss' : ''}: no accepted destruction is undone, and the stopped one is completed or not accepted`, async () => {
        const accepted = await ready(); // t3's destruction: accepted
        const backup = loss ? (() => { const s = new FakeKeysDb(); s.addTenant(T1, 't1', { 1: 'RETIRED', 2: 'ACTIVE' }); s.addTenant(T2, 't2', { 1: 'RETIRED', 2: 'ACTIVE' }, [1]); s.addTenant(T3, 't3', { 1: 'ACTIVE' }); return s.snapshot(); })() : null;
        await expect(
          destroy(
            deps({
              crash: (p) => {
                if (p.replace(/dest-[0-9a-f]+/, 'dest') === point.replace(/dest-[0-9a-f]+/, 'dest')) throw new Crash(p);
              },
            }),
            { slug: 't1' },
          ),
        ).rejects.toBeInstanceOf(Crash);
        const op = [...opStates(entriesOf(readCopy(primary))).ops.keys()].find((o) => o !== accepted) ?? '';
        // The platform DB, Vault and the bucket replaced by an older backup's state (from before both destructions).
        if (backup) db.restore(backup);

        const r = await recover(deps());
        expect(r.ok, r.lines.join('\n')).toBe(true);
        // The accepted destruction holds, whatever the database's age.
        expect(db.keysOf(T3)).toEqual({ 1: 'DESTROYED' });
        expect(outcomeOf(accepted)).toBe('committed');
        // The stopped one: a pending record means the owner asked for it; it is completed (rolled forward or read
        // from the evidence) and recorded, never forgotten. Every op ends committed or aborted.
        if (op) {
          expect(outcomeOf(op)).toBe('committed');
          expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED', 2: 'DESTROYED' });
        }
        for (const s of opStates(entries()).ops.values()) expect(s.outcome).not.toBeNull();
        // Nothing destroyed twice: at most one destruction per op reached the database's present state.
        expect(r.lines.join('\n')).toMatch(/authoritative on 2 destination/);
        // A second recovery changes nothing.
        const n = entries().length;
        expect((await recover(deps())).ok).toBe(true);
        expect(entries()).toHaveLength(n);
      });
});

describe('[BK11] the two named cases', () => {
  it('[BK11] the commit boundary: committed in the database, stopped before `committed` reached any destination; recovery appends it once, destroying nothing twice', async () => {
    await ready();
    await expect(destroy(deps({ crash: (p) => { if (p === 'db:after') throw new Crash(p); } }), { slug: 't1' })).rejects.toBeInstanceOf(Crash);
    const op = [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';
    const before = db.calls.length;
    expect((await recover(deps())).ok).toBe(true);
    const committed = entries().filter((e) => e.type === 'committed' && e.op === op);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ by: 'recovery' });
    expect(db.calls.slice(before)).toEqual(['evidence']); // no destroy, no reapply
  });

  it.each<[string, (op: string) => void]>([
    ['a row for another tenant', (op) => db.forgeRow({ op, tenantId: T2, kind: 'TENANT', versions: [1, 2], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '99', audit: null }, { action: 'crypto.tenant_key.destroyed', tenantId: T2, op, versions: [1, 2] })],
    ['a row for other versions', (op) => db.forgeRow({ op, tenantId: T1, kind: 'TENANT', versions: [2], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '99', audit: null }, { action: 'crypto.tenant_key.destroyed', tenantId: T1, op, versions: [2] })],
    ['a row whose audit event is missing', (op) => db.forgeRow({ op, tenantId: T1, kind: 'TENANT', versions: [1, 2], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '99', audit: null })],
    ['a row whose keys are not DESTROYED', (op) => {
      db.forgeRow({ op, tenantId: T1, kind: 'TENANT', versions: [1, 2], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '99', audit: null }, { action: 'crypto.tenant_key.destroyed', tenantId: T1, op, versions: [1, 2] });
    }],
  ])('[BK11] the commit boundary with conflicting evidence stops recovery: %s', async (name, forge) => {
    await ready();
    await expect(destroy(deps({ crash: (p) => { if (p === 'db:before') throw new Crash(p); } }), { slug: 't1' })).rejects.toBeInstanceOf(Crash);
    const op = [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';
    forge(op);
    // Only the one thing named is wrong: otherwise the keys are as a committed destruction leaves them.
    if (!name.includes('not DESTROYED')) for (const v of [1, 2]) db.setKey(T1, v, { status: 'DESTROYED', wrapErased: true });
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(new RegExp(`STOP: pending op ${op}: conflicting evidence`));
    expect(outcomeOf(op)).toBe('pending');
  });

  it('[BK11] the older database: after the same stop the database is replaced by an older backup; recovery replays the pending destruction and appends committed', async () => {
    await ready();
    const older = db.snapshot();
    await expect(destroy(deps({ crash: (p) => { if (p === 'db:after') throw new Crash(p); } }), { slug: 't1' })).rejects.toBeInstanceOf(Crash);
    const op = [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';
    db.restore(older);
    expect(db.rowOf(op)).toBeUndefined();
    expect((await recover(deps())).ok).toBe(true);
    expect(outcomeOf(op)).toBe('committed');
    expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED', 2: 'DESTROYED' });
  });
});

describe('[BK2] recovery and re-apply', () => {
  it('[BK2] a committed destruction whose keys a restore brought back is destroyed again and recorded', async () => {
    const older = db.snapshot(); // a backup from before t3's destruction
    const op = await ready();
    db.restore(older);
    expect(db.keysOf(T3)).toEqual({ 1: 'ACTIVE' });
    const r = await recover(deps());
    expect(r.ok).toBe(true);
    expect(db.keysOf(T3)).toEqual({ 1: 'DESTROYED' });
    expect(db.rowOf(op)).toMatchObject({ audit: expect.objectContaining({ action: 'crypto.tenant_key.reapplied' }) });
    expect(entries().filter((e) => e.type === 'reapplied')).toHaveLength(1);
    expect(r.lines.join('\n')).toMatch(/re-applied after a restore/);
  });

  it('[BK2] a pending destruction is rolled forward and gains committed; an aborted one changes nothing; nothing to do changes nothing', async () => {
    await ready();
    await expect(destroy(deps({ crash: (p) => { if (p === 'db:before') throw new Crash(p); } }), { slug: 't1' })).rejects.toBeInstanceOf(Crash);
    expect((await recover(deps())).ok).toBe(true);
    expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED', 2: 'DESTROYED' });
    db.setKey(T2, 1, { eligible: false });
    const refused = await destroy(Object.assign(deps(), { db: Object.assign(Object.create(db) as FakeKeysDb, { check: () => Promise.resolve({ eligible: true, tenantId: T2, kind: 'RETIRED', versions: [1], preconditions: {} }) }) }), { slug: 't2', version: 1 });
    expect(outcomeOf(refused.op ?? '')).toBe('aborted');
    const n = entries().length;
    const calls = db.calls.length;
    expect((await recover(deps())).ok).toBe(true);
    expect(entries()).toHaveLength(n);
    expect(db.calls.slice(calls)).toEqual(['evidence']);
    expect(db.keysOf(T2)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
  });

  it('[BK2] a re-applied RETIRED destruction whose version a restore made ACTIVE again is destroyed, with a warning', async () => {
    await init(deps(), [externalPath]);
    const older = new FakeKeysDb();
    older.addTenant(T2, 't2', { 1: 'ACTIVE' }); // before the rotation
    const r = await destroy(deps(), { slug: 't2', version: 1 });
    expect(r.ok).toBe(true);
    db.restore(older.snapshot());
    const rec = await recover(deps());
    expect(rec.ok).toBe(true);
    expect(db.keysOf(T2)).toEqual({ 1: 'DESTROYED' });
    expect(rec.lines.join('\n')).toMatch(/WARNING: t2's ACTIVE key was among them/);
  });
});

describe('[BK12] failing closed, naming the op or the destination', () => {
  const crashAt = (point: string) => deps({ crash: (p) => { if (p === point) throw new Crash(p); } });
  const file = (d: Destination) => join(copyDir(d.path, (entries()[0] as { ledgerId: string }).ledgerId), 'ledger.jsonl');

  it.each<[string, () => Promise<void> | void, RegExp]>([
    ['no readable durable destination', () => { rmSync(primary.path, { recursive: true }); rmSync(externalPath, { recursive: true }); }, /no authoritative ledger can be established/],
    ['a chain that does not verify (an edited entry)', () => { const f = file(primary); writeFileSync(f, readFileSync(f, 'utf8').replace('"slug":"t3"', '"slug":"tx"')); }, /hash does not match/],
    ['a deleted entry', () => { const f = file(primary); const lines = readFileSync(f, 'utf8').split('\n'); lines.splice(1, 1); writeFileSync(f, lines.join('\n')); }, /out of order/],
    ['copies that diverge', async () => {
      const ext = { id: destinationsOf(entries())[1]?.id ?? '', path: externalPath };
      const fe = file(ext);
      const fp = file(primary);
      writeFileSync(fe, readFileSync(fe, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
      writeFileSync(fp, readFileSync(fp, 'utf8').split('\n').slice(0, 2).join('\n') + '\n');
      await Promise.resolve();
      // Each now gets a different next record, written straight to its own copy.
      const { nextEntry, lineOf } = await import('./chain.js');
      const base = establishAuthority(primary);
      if (!base.ok) throw new Error('setup');
      const last = base.entries.at(-1) ?? null;
      writeFileSync(fp, readFileSync(fp, 'utf8') + lineOf(nextEntry(last, { type: 'aborted', op: '00000000-0000-4000-8000-00000000000a', reason: 'x' })));
      writeFileSync(fe, readFileSync(fe, 'utf8') + lineOf(nextEntry(last, { type: 'aborted', op: '00000000-0000-4000-8000-00000000000b', reason: 'y' })));
    }, /diverge|inconsistent/],
    ['a key_destruction row the ledger lacks', () => db.forgeRow({ op: '20000000-0000-4000-8000-000000000000', tenantId: T1, kind: 'TENANT', versions: [1], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '5', audit: null }), /a key_destruction row for op 20000000-0000-4000-8000-000000000000, which the ledger lacks/],
  ])('[BK12] %s stops recovery', async (_name, make, why) => {
    await ready();
    await make();
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(why);
  });

  it("[BK12] a pending op whose preconditions no longer hold stops recovery, naming it and the owner's choice; abandon records it aborted", async () => {
    await ready();
    await expect(destroy(crashAt('db:before'), { slug: 't2', version: 1 })).rejects.toBeInstanceOf(Crash);
    const op = [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';
    db.setKey(T2, 1, { eligible: false });
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(new RegExp(`pending op ${op} \\(t2\\): its preconditions no longer hold \\(sweep_pending\\).*ledger abandon ${op}`));
    expect((await abandon(deps(), op, 'short')).ok).toBe(false); // a reason is required
    expect((await abandon(deps(), op, 'the retired version is still in use')).ok).toBe(true);
    expect(outcomeOf(op)).toBe('aborted');
    expect(db.audited).toContain('op_abandoned');
    expect((await recover(deps())).ok).toBe(true);
  });

  it('[BK12] an op recorded as aborted while the database holds its row stops recovery', async () => {
    await ready();
    db.setKey(T2, 1, { eligible: false });
    const r = await destroy(Object.assign(deps(), { db: Object.assign(Object.create(db) as FakeKeysDb, { check: () => Promise.resolve({ eligible: true, tenantId: T2, kind: 'RETIRED', versions: [1], preconditions: {} }) }) }), { slug: 't2', version: 1 });
    const op = r.op ?? '';
    expect(outcomeOf(op)).toBe('aborted');
    db.forgeRow({ op, tenantId: T2, kind: 'RETIRED', versions: [1], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '50', audit: null }, { action: 'crypto.tenant_key.destroyed', tenantId: T2, op, versions: [1] });
    const rec = await recover(deps());
    expect(rec.ok).toBe(false);
    expect(rec.lines.join('\n')).toMatch(new RegExp(`op ${op} is recorded as aborted, but the database holds its key_destruction row`));
  });

  it('[BK2] decision 7: a committed destruction whose tenant has no keys in this database (a reset demo database) holds, reported, and never blocks', async () => {
    const op = await ready();
    const empty = new FakeKeysDb();
    db.restore(empty.snapshot());
    const n = entries().length;
    const r = await recover(deps());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(r.lines.join('\n')).toMatch(new RegExp(`op ${op} \\(t3\\): none of its key versions exists in this database: in force`));
    expect(db.calls.filter((c) => c.startsWith('reapply:'))).toHaveLength(0);
    expect(entries()).toHaveLength(n); // nothing written: the next deploy reports it again, and stays unblocked
  });

  it('[BK12] abandon never applies to an op that committed in the database', async () => {
    await ready();
    await expect(destroy(crashAt('db:after'), { slug: 't1' })).rejects.toBeInstanceOf(Crash);
    const op = [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';
    expect((await abandon(deps(), op, 'trying to undo it')).lines.join()).toMatch(/committed in the database/);
    expect(outcomeOf(op)).toBe('pending');
  });

  it('[BK12] a committed op whose keys cannot be destroyed again stops recovery', async () => {
    const older = db.snapshot();
    const op = await ready();
    db.restore(older);
    db.forgeRow({ op, tenantId: T1, kind: 'TENANT', versions: [1], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '9', audit: null }, { action: 'crypto.tenant_key.destroyed', tenantId: T1, op, versions: [1] });
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(new RegExp(`committed op ${op}: conflicting evidence`));
    expect(db.keysOf(T3)).toEqual({ 1: 'ACTIVE' }); // stopped, and says so: the deploy never starts the app
  });

  it('[BK12] the object-locked bucket alone is never accepted as the ledger', async () => {
    await ready();
    expect(db.bucket.length).toBeGreaterThan(0);
    rmSync(primary.path, { recursive: true });
    rmSync(externalPath, { recursive: true });
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/A backup set's copy or the bucket's can never stand in for it/);
  });

  it('[BK12] the evidence job failing stops recovery (never treated as "no rows")', async () => {
    await ready();
    db.fault = 'evidence-fails';
    await expect(recover(deps())).rejects.toThrow(/the keys job failed/);
  });
});

describe('[BK13] destinations', () => {
  const failingFor = (path: string, when: () => boolean): LedgerFs => ({
    ...realFs,
    appendDurable: (p, d) => {
      if (p.startsWith(path) && when()) throw new Error('EIO: the drive went away');
      realFs.appendDurable(p, d);
    },
  });

  it('[BK13] a destination that cannot be written before the database step stops the destruction with nothing changed', async () => {
    await ready();
    const r = await destroy(deps({ fs: failingFor(externalPath, () => true) }), { slug: 't1' });
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/stopped before the database: .*EIO/);
    expect(db.calls).not.toContain(`destroy:${r.op ?? ''}`);
    expect(db.keysOf(T1)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
    // Once it is back, recovery levels it: the op is aborted, and nothing is destroyed.
    expect((await recover(deps())).ok).toBe(true);
    expect(outcomeOf(r.op ?? '')).toBe('aborted');
    expect(db.keysOf(T1)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
  });

  it('[BK13] one that fails after the database step keeps the command from reporting success; the next recovery completes the records', async () => {
    await ready();
    let committedWrites = 0;
    const fs = failingFor(externalPath, () => committedWrites++ >= 1); // pending reaches it; committed doesn't
    const r = await destroy(deps({ fs }), { slug: 't1' });
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/keys are destroyed, but the committed record is not durable everywhere .*NOT accepted yet/);
    expect((await recover(deps())).ok).toBe(true);
    expect(outcomeOf(r.op ?? '')).toBe('committed');
    const ext = destinationsOf(entries())[1];
    expect(ext && entriesOf(readCopy(ext)).length).toBe(entries().length);
  });
});
