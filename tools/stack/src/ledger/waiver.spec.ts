// Spec 0020 D8's waiver, BK17 (A3): `ledger waive`, against the in-memory database model. The protocol's own cases are
// in protocol.spec.ts; the real CLI and database in real-keys.int.ts.
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ledgerIdOf, nextEntry, opStates, planStates, WAIVER_STATEMENT, type Destination } from './chain.js';
import { init } from './commands.js';
import { FakeKeysDb } from './fake-keys-db.js';
import { establishAuthority, generationOfRecord } from './ledger.js';
import { destroy, recover, type ProtocolDeps } from './protocol.js';
import { listLocations, realFs, type LedgerFs } from './store.js';
import { waive, WAIVER_CONFIRMATION } from './waiver.js';

const T1 = '10000000-0000-4000-8000-000000000001';
const T2 = '10000000-0000-4000-8000-000000000002';
const T3 = '10000000-0000-4000-8000-000000000003';
class Crash extends Error {}

let root: string;
let primary: Destination;
let ext: string;
let ext2: string;
let db: FakeKeysDb;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-waiver-'));
  primary = { id: 'primary', path: join(root, 'primary') };
  ext = join(root, 'external');
  ext2 = join(root, 'second-drive');
  db = new FakeKeysDb();
  db.addTenant(T1, 't1', { 1: 'ACTIVE' });
  db.addTenant(T2, 't2', { 1: 'RETIRED', 2: 'ACTIVE' }, [1]);
  db.addTenant(T3, 't3', { 1: 'ACTIVE' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (over: Partial<ProtocolDeps> = {}): ProtocolDeps => ({ primary, db, lock: () => Promise.resolve({ release: () => undefined }), log: () => undefined, ...over });
const crashAt = (point: string) => deps({ crash: (p) => { if (p === point) throw new Crash(p); } });
const args = (over: Partial<{ reason: string; confirm: string; destinations: string[]; from: string[] }> = {}) => ({
  reason: 'both drives were lost in the flood',
  confirm: WAIVER_CONFIRMATION,
  destinations: [primary.path, ext2],
  from: [],
  ...over,
});
const authority = () => establishAuthority(primary);
const entries = () => {
  const a = authority();
  if (!a.ok) throw new Error(a.problems.join('\n'));
  return a.entries;
};

/** Generation 1 with destructions, then every configured destination lost: recovery is blocked. */
async function lost(): Promise<{ accepted: string }> {
  expect((await init(deps(), [ext])).ok).toBe(true);
  const done = await destroy(deps(), { slug: 't3' }); // accepted: its records are in the bucket too
  expect(done.ok).toBe(true);
  rmSync(primary.path, { recursive: true, force: true });
  rmSync(ext, { recursive: true, force: true });
  expect((await recover(deps())).ok).toBe(false);
  return { accepted: done.op ?? '' };
}

describe('[BK17] refusals: nothing is written', () => {
  it.each<[string, Partial<NonNullable<Parameters<typeof args>[0]>>, RegExp]>([
    ['without the exact phrase', { confirm: 'yes' }, /needs its exact confirmation/],
    ['without a reason', { reason: '' }, /a reason is required/],
    ['naming no destination', { destinations: [] }, /name the new generation's destinations/],
    // ext2 is set in beforeEach, after the table is built: a sentinel stands for it.
    ['without the primary among them', { destinations: ['<ext2>'] }, /must be one of the new generation's destinations/],
  ])('[BK17] %s', async (_n, over, why) => {
    await lost();
    const r = await waive(deps(), args({ ...over, ...(over.destinations ? { destinations: over.destinations.map((p) => (p === '<ext2>' ? ext2 : p)) } : {}) }));
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(why);
    expect(listLocations(ext2).locations).toEqual([]);
    expect(db.calls.filter((c) => c.startsWith('waiverAudit') || c.startsWith('reapply'))).toEqual([]);
  });

  it('[BK17][BK16] refused while a configured destination is readable: the guarantee-preserving commands apply', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    rmSync(primary.path, { recursive: true, force: true });
    // With the primary lost, the owner names the drive they still have.
    const r = await waive(deps(), args({ from: [ext] }));
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/is readable .*no waiver.*rebuild-destination/);
  });

  it('[BK17][BK16] refused while a configured destination is readable, found through the bucket alone (the primary, which named it, is lost)', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    expect((await destroy(deps(), { slug: 't3' })).ok).toBe(true); // the bucket now holds the genesis naming ext
    rmSync(primary.path, { recursive: true, force: true });
    const r = await waive(deps(), args());
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/is readable \(.*external.*\).*no waiver/);
    expect(listLocations(ext2).locations).toEqual([]);
  });
});

describe('[BK17] the bootstrap', () => {
  it('[BK17] with every named destination writable: a fresh generation, established everywhere, its plan re-applied, audited once', async () => {
    const { accepted } = await lost();
    const r = await waive(deps(), args());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(r.lines.join('\n')).toMatch(/no-resurrection guarantee waived since/);
    const a = authority();
    if (!a.ok) throw new Error(a.problems.join());
    expect(a.at.generation).toBe(2);
    const g = a.entries[0];
    expect(g?.type === 'genesis' && g.transition?.statement).toBe(WAIVER_STATEMENT);
    expect(g?.type === 'genesis' && g.transition?.reason).toBe('both drives were lost in the flood');
    // The plan holds the accepted destruction found in the bucket, now re-applied in generation 2.
    const plan = planStates(a.entries).plan;
    expect(plan.get(accepted)).toMatchObject({ item: { mode: 'reapply', tenant: { id: T3 } }, result: { type: 'reapplied' } });
    expect(db.keysOf(T3)).toEqual({ 1: 'DESTROYED' });
    expect(db.waivers.size).toBe(1);
    expect(a.entries.filter((e) => e.type === 'audited')).toHaveLength(1);
    // Fresh directories: generation 2's attempt sits beside nothing old.
    for (const d of a.destinations) expect(listLocations(d.path).locations.map((l) => l.generation)).toEqual([2]);
    // Recovery proceeds, and says the guarantee is waived, every time.
    for (let i = 0; i < 2; i++) {
      const rec = await recover(deps());
      expect(rec.ok, rec.lines.join('\n')).toBe(true);
      expect(rec.lines.join('\n')).toMatch(/no-resurrection guarantee waived since .* \(generation 2\)/);
    }
    expect(db.waivers.size).toBe(1);
  });

  it('[BK17] with one named destination unwritable: the waiver fails, no generation exists, the database is untouched, recovery stays blocked', async () => {
    await lost();
    const failing: LedgerFs = { ...realFs, mkdirp: (p) => (p.startsWith(ext2) ? (() => { throw new Error('EACCES'); })() : realFs.mkdirp(p)) };
    const r = await waive(deps({ fs: failing }), args());
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/W1, the candidate.*No generation exists, nothing in the database changed/);
    expect(db.calls.filter((c) => c.startsWith('waiverAudit') || c.startsWith('reapply') || c.startsWith('destroy:'))).toEqual(['destroy:' + (db.calls.find((c) => c.startsWith('destroy:'))?.slice(8) ?? '')]);
    expect(db.waivers.size).toBe(0);
    expect((await recover(deps())).ok).toBe(false);
  });

  it('[BK17] with `established` unwritable on one destination: the waiver fails, the attempt is inert, the database is untouched, recovery stays blocked', async () => {
    await lost();
    const failing: LedgerFs = {
      ...realFs,
      appendDurable: (p, data) => (p.startsWith(ext2) && data.toString('utf8').includes('"established"') ? (() => { throw new Error('EIO'); })() : realFs.appendDurable(p, data)),
    };
    const r = await waive(deps({ fs: failing }), args());
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/W2, establishing.*This attempt is inert/);
    expect(db.waivers.size).toBe(0);
    expect(db.calls.some((c) => c.startsWith('reapply:'))).toBe(false);
    expect(generationOfRecord(primary)).toMatchObject({ ok: true, at: { generation: 1 } }); // never authority
    expect((await recover(deps())).ok).toBe(false);
  });

  it('[BK17] a destruction in no copy at all, but in the database, is in the plan (a row is an accepted destruction)', async () => {
    await lost();
    db.bucketReadable = false; // only the database remembers t3 now
    const r = await waive(deps(), args());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(r.lines.join('\n')).toMatch(/the bucket could not be read/);
    const plan = [...planStates(entries()).plan.values()];
    expect(plan.map((p) => [p.item.tenant.id, p.item.source])).toEqual([[T3, 'the database']]);
  });
});

describe('[A3-4] a pending destruction never accepted: re-run with its preconditions, never forced', () => {
  /** t2's retired v1 left pending (stopped before the database), in a damaged copy saved before the loss. */
  async function pendingInASavedCopy(): Promise<{ op: string; saved: string }> {
    expect((await init(deps(), [ext])).ok).toBe(true);
    await expect(destroy(crashAt('db:before'), { slug: 't2', version: 1 })).rejects.toBeInstanceOf(Crash);
    const op = [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';
    const saved = join(root, 'saved');
    cpSync(primary.path, saved, { recursive: true });
    const file = readdirSync(saved, { recursive: true, encoding: 'utf8' }).find((f) => f.endsWith('ledger.jsonl')) ?? '';
    appendFileSync(join(saved, file), '{"not":"an entry"}\n');
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    return { op, saved };
  }

  it('[A3-4] its preconditions still hold: rolled forward, destroyed, recorded', async () => {
    const { op, saved } = await pendingInASavedCopy();
    const r = await waive(deps(), args({ from: [saved] }));
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(planStates(entries()).plan.get(op)).toMatchObject({ item: { mode: 'rollforward' }, result: { type: 'reapplied' } });
    expect(db.keysOf(T2)).toEqual({ 1: 'DESTROYED', 2: 'ACTIVE' });
  });

  it('[A3-4] its preconditions no longer hold: refused, recorded as not applied with the reason, nothing destroyed', async () => {
    const { op, saved } = await pendingInASavedCopy();
    db.setKey(T2, 1, { eligible: false }); // a sweep re-requested since
    const r = await waive(deps(), args({ from: [saved] }));
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(planStates(entries()).plan.get(op)).toMatchObject({ item: { mode: 'rollforward' }, result: { type: 'not_applied', reason: 'sweep_pending' } });
    expect(db.keysOf(T2)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
    expect(db.calls.some((c) => c.startsWith('reapply:'))).toBe(false);
  });
});

describe('[BK17][A3-8] after the waiver, the new generation is the only authority', () => {
  it('[A3-8] a destruction with a new-generation destination unavailable stops before the database changes, and nothing is reported done', async () => {
    await lost();
    expect((await waive(deps(), args())).ok).toBe(true);
    rmSync(ext2, { recursive: true, force: true });
    const r = await destroy(deps(), { slug: 't1' });
    expect(r.ok).toBe(false);
    expect(db.keysOf(T1)).toEqual({ 1: 'ACTIVE' });
    expect(db.calls.some((c) => c.startsWith('check:t1'))).toBe(false);
  });

  it('[A3-8] recovery with a new-generation destination unavailable fails closed, though the old generation\'s copies and the bucket are at hand; reconnecting it lets it proceed', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    expect((await destroy(deps(), { slug: 't3' })).ok).toBe(true);
    const savedP = join(root, 'saved-primary');
    const savedE = join(root, 'saved-ext');
    cpSync(primary.path, savedP, { recursive: true });
    cpSync(ext, savedE, { recursive: true });
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    expect((await waive(deps(), args())).ok).toBe(true);
    // The old generation comes back, complete and verifying, on both of its destinations; the new one loses a drive.
    cpSync(join(savedP), primary.path, { recursive: true });
    cpSync(savedE, ext, { recursive: true });
    const second = join(root, 'second-saved');
    cpSync(ext2, second, { recursive: true });
    rmSync(ext2, { recursive: true, force: true });
    const blocked = await recover(deps());
    expect(blocked.ok).toBe(false);
    expect(blocked.lines.join('\n')).toMatch(/generation 2 is established, and it is the only authority .*can't be read: dest-/);
    // An old-generation copy is never accepted as the new generation's authority.
    expect(generationOfRecord(primary).ok).toBe(false);
    cpSync(second, ext2, { recursive: true });
    expect((await recover(deps())).ok).toBe(true);
  });

  it('[A3-7] a planned destruction re-applied by the waiver, then undone by a restore, is re-applied by recovery', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    const older = db.snapshot(); // t3's keys live, no row: a backup from before its destruction
    const done = await destroy(deps(), { slug: 't3' });
    expect(done.ok).toBe(true);
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    expect((await waive(deps(), args())).ok).toBe(true);
    db.restore(older);
    expect(db.keysOf(T3)).toEqual({ 1: 'ACTIVE' });
    const r = await recover(deps());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(db.keysOf(T3)).toEqual({ 1: 'DESTROYED' });
  });

  it('[A3-11] two attempts established for one generation (impossible under the lock): nothing is decided, recovery stops', async () => {
    await lost();
    expect((await waive(deps(), args())).ok).toBe(true);
    const savedP = join(root, 'first-primary');
    const savedE = join(root, 'first-second');
    cpSync(primary.path, savedP, { recursive: true });
    cpSync(ext2, savedE, { recursive: true });
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext2, { recursive: true, force: true });
    expect((await waive(deps(), args())).ok).toBe(true); // generation 2 again, as a second attempt
    cpSync(savedP, primary.path, { recursive: true });
    cpSync(savedE, ext2, { recursive: true });
    expect(new Set(listLocations(primary.path).locations.map((l) => l.generation))).toEqual(new Set([2]));
    expect(listLocations(primary.path).locations).toHaveLength(2);
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/two attempts are established for generation 2/);
  });

  it("[A3] a destination whose marker names generation 2 but whose generation-2 directory is gone fails closed (the old generation can't step in)", async () => {
    await lost();
    expect((await waive(deps(), args({ destinations: [primary.path] }))).ok).toBe(true);
    const ledgerId = readdirSync(primary.path).find((n) => !n.startsWith('.')) ?? '';
    rmSync(join(primary.path, ledgerId, 'gen-0002'), { recursive: true, force: true });
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/records generation 2 .* as current, but no established copy of it can be read/);
  });

  it('[BK17][BK11] a destruction made after the waiver is guaranteed again: a restore that undoes it is undone', async () => {
    await lost();
    expect((await waive(deps(), args())).ok).toBe(true);
    const older = db.snapshot();
    const r = await destroy(deps(), { slug: 't1' });
    expect(r.ok, r.lines.join()).toBe(true);
    db.restore(older);
    expect(db.keysOf(T1)).toEqual({ 1: 'ACTIVE' });
    expect((await recover(deps())).ok).toBe(true);
    expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED' });
  });
});

describe('[BK17] crash injection in the waiver itself', () => {
  it('[BK17] after the candidate reaches one destination: no generation is authoritative, the deploy stays blocked; a retry is a new attempt, and the inert one is never read', async () => {
    await lost();
    await expect(waive(crashAt('waive:candidate:primary'), args())).rejects.toBeInstanceOf(Crash);
    expect((await recover(deps())).ok).toBe(false);
    const r = await waive(deps(), args());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    const attempts = listLocations(primary.path).locations.filter((l) => l.generation === 2);
    expect(attempts).toHaveLength(2); // the inert candidate, and the established attempt beside it
    const a = authority();
    expect(a.ok && a.at.attempt).toBe(attempts.find((l) => l.attempt !== attempts[0]?.attempt || true)?.attempt && (a.ok ? a.at.attempt : ''));
    expect((await recover(deps())).ok).toBe(true);
  });

  it('[BK17] with the candidate on every destination but `established` on only some: still not authoritative, the same as above', async () => {
    await lost();
    await expect(waive(crashAt('waive:established:primary'), args())).rejects.toBeInstanceOf(Crash);
    const rec = await recover(deps());
    expect(rec.ok).toBe(false);
    expect(db.waivers.size).toBe(0);
    expect((await waive(deps(), args())).ok).toBe(true);
    expect((await recover(deps())).ok).toBe(true);
  });

  it('[BK17] after `established` is durable everywhere, before the audit event: recovery writes it once; a second recovery writes nothing more', async () => {
    await lost();
    await expect(waive(crashAt('waive:audit'), args())).rejects.toBeInstanceOf(Crash);
    expect(db.waivers.size).toBe(1); // the event was written; the ledger hadn't recorded it yet
    expect((await recover(deps())).ok).toBe(true);
    expect(db.waivers.size).toBe(1);
    expect(entries().filter((e) => e.type === 'audited')).toHaveLength(1);
    expect((await recover(deps())).ok).toBe(true);
    expect(entries().filter((e) => e.type === 'audited')).toHaveLength(1);
  });

  it("[BK17] during the re-applications, between an op's transaction and its record: recovery resumes the outstanding ones only; nothing is recorded twice", async () => {
    const { accepted } = await lost();
    await expect(waive(crashAt(`waive:applied:${accepted}`), args())).rejects.toBeInstanceOf(Crash);
    const before = db.calls.filter((c) => c === `reapply:${accepted}`).length;
    expect((await recover(deps())).ok).toBe(true);
    expect(db.calls.filter((c) => c === `reapply:${accepted}`).length).toBe(before + 1); // idempotent by op: re-run, recorded once
    expect(entries().filter((e) => e.type === 'reapplied' && e.op === accepted)).toHaveLength(1);
    expect(db.keysOf(T3)).toEqual({ 1: 'DESTROYED' });
    // The app may start only now: destroy is no longer held back.
    expect((await destroy(deps(), { slug: 't1' })).ok).toBe(true);
  });

  it('[BK17] during the re-applications, after some ops and before others: recovery resumes the outstanding ones only', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    const a = await destroy(deps(), { slug: 't3' });
    const b = await destroy(deps(), { slug: 't1' });
    expect(a.ok && b.ok).toBe(true);
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    const [first, second] = [a.op ?? '', b.op ?? ''].sort(); // the plan runs in op order
    await expect(waive(crashAt(`waive:applied:${second ?? ''}`), args())).rejects.toBeInstanceOf(Crash);
    const runs = (op = '') => db.calls.filter((c) => c === `reapply:${op}`).length;
    const [r1, r2] = [runs(first), runs(second)];
    expect((await recover(deps())).ok).toBe(true);
    expect([runs(first), runs(second)]).toEqual([r1, r2 + 1]); // the recorded one is never run again
    for (const op of [first, second]) expect(entries().filter((e) => e.type === 'reapplied' && e.op === op)).toHaveLength(1);
  });

  it('[BK17] the app may not start (nothing new is destroyed) until every planned op is recorded', async () => {
    const { accepted } = await lost();
    await expect(waive(crashAt(`waive:applied:${accepted}`), args())).rejects.toBeInstanceOf(Crash);
    const r = await destroy(deps(), { slug: 't1' });
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/the waiver's re-applications are unfinished/);
  });

  it('[BK17] conflicting evidence during resumption (a row that does not match its planned op) stops recovery', async () => {
    const { accepted } = await lost();
    await expect(waive(crashAt('waive:audit'), args())).rejects.toBeInstanceOf(Crash);
    db.forgeRow({ op: accepted, tenantId: T1, kind: 'TENANT', versions: [1], destroyedAt: '2026-10-23T00:00:00.000Z', auditSeq: '90', audit: null });
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(new RegExp(`planned op ${accepted} .*could not be re-applied \\(conflict\\)`));
    expect(opStates(entries()).problems).toEqual([]);
  });
});

describe('[BK17] never by itself', () => {
  it('[BK17] no deploy, recovery or restore ever waives: recovery with every destination lost stays blocked, and nothing is written', async () => {
    await lost();
    for (let i = 0; i < 2; i++) expect((await recover(deps())).ok).toBe(false);
    expect(existsSync(primary.path)).toBe(false);
    expect(db.waivers.size).toBe(0);
  });
});

describe('[A3] the bucket copy after a waiver', () => {
  it('[A3] files the new generation under gen-NNNN/<attempt>, with its own progress (its seq starts again at 1)', async () => {
    const progress = new Map<string, number>();
    const bucket = { copied: (id: string) => progress.get(id) ?? 0, mark: (id: string, seq: number) => void progress.set(id, seq) };
    expect((await init(deps({ bucket }), [ext])).ok).toBe(true);
    expect((await destroy(deps({ bucket }), { slug: 't3' })).ok).toBe(true);
    const gen1 = db.bucket.length;
    expect(db.bucketDirs.every((d) => d === 'gen-0001')).toBe(true);
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    expect((await waive(deps({ bucket }), args())).ok).toBe(true);
    const r = await recover(deps({ bucket }));
    expect(r.ok, r.lines.join('\n')).toBe(true);
    const g = entries()[0];
    if (g?.type !== 'genesis' || !g.attempt) throw new Error('no generation 2');
    const dir = `gen-0002/${g.attempt}`;
    expect(db.bucketDirs.slice(gen1)).toEqual(entries().map(() => dir));
    expect(db.bucket.slice(gen1).map((e) => e.seq)).toEqual(entries().map((e) => e.seq));
    expect(progress.get(`${g.ledgerId}/${dir}`)).toBe(entries().at(-1)?.seq);
  });
});

describe('[A3] the bucket holds every ledger it was ever sent', () => {
  const foreign = () => nextEntry(null, { type: 'genesis', ledgerId: randomUUID(), generation: 1, destinations: [{ id: 'primary', path: join(root, 'elsewhere') }] });

  it('[A3] only the ledger the copies on disk name counts: another one in the bucket is reported, not planned, and blocks nothing', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    expect((await destroy(deps(), { slug: 't3' })).ok).toBe(true);
    const ours = ledgerIdOf(entries());
    // A damaged copy saved before the loss: it verifies only up to the damage (never a copy of record).
    const saved = join(root, 'saved');
    cpSync(primary.path, saved, { recursive: true });
    const file = readdirSync(saved, { recursive: true, encoding: 'utf8' }).find((f) => f.endsWith('ledger.jsonl')) ?? '';
    appendFileSync(join(saved, file), '{"not":"an entry"}\n');
    rmSync(primary.path, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
    db.bucket.push(foreign());
    const r = await waive(deps(), args({ from: [saved] }));
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(r.lines.join('\n')).toMatch(/the bucket also holds other ledgers .*not this one, not in the plan/);
    // The same ledger, continued; the accepted destruction is planned, and nothing from the other ledger.
    expect(ledgerIdOf(entries())).toBe(ours);
    expect([...planStates(entries()).plan.values()].map((p) => p.item.tenant.id)).toEqual([T3]);
  });

  it('[A3] with no copy on disk and more than one ledger in the bucket: refused, nothing written', async () => {
    await lost();
    db.bucket.push(foreign());
    const r = await waive(deps(), args());
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/no copy on disk, and the bucket holds more than one ledger/);
    expect(listLocations(ext2).locations).toEqual([]);
    expect(db.waivers.size).toBe(0);
  });
});
