// Spec 0020 BK16 (A2-3): the ledger's configuration commands keep the guarantee, or change nothing.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { destinationsOf, type Destination } from './chain.js';
import { addDestination, init, rebuildDestination, removeDestination, status } from './commands.js';
import { FakeKeysDb } from './fake-keys-db.js';
import { establishAuthority } from './ledger.js';
import { destroy, recover, type ProtocolDeps } from './protocol.js';
import { entriesOf, readCopy } from './store.js';

const T1 = '10000000-0000-4000-8000-000000000001';
const T2 = '10000000-0000-4000-8000-000000000002';

let root: string;
let primary: Destination;
let ext: string;
let db: FakeKeysDb;
const deps = (): ProtocolDeps => ({ primary, db, lock: () => Promise.resolve({ release: () => undefined }), log: () => undefined });
const authority = () => establishAuthority(primary);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-commands-'));
  primary = { id: 'primary', path: join(root, 'primary') };
  ext = join(root, 'external');
  db = new FakeKeysDb();
  db.addTenant(T1, 't1', { 1: 'ACTIVE' });
  db.addTenant(T2, 't2', { 1: 'ACTIVE' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('[A2-3] init', () => {
  it('[A2-3] creates the ledger on every named destination, audited; never runs over one', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    const a = authority();
    expect(a.ok && a.destinations.map((d) => d.path)).toEqual([primary.path, ext]);
    expect(db.audited).toEqual(['initialised']);
    expect((await init(deps())).lines.join()).toMatch(/already holds a ledger/);
  });

  it('[A2-3] refuses when the database already records a destruction: that stack had a ledger', async () => {
    db.forgeRow({ op: '20000000-0000-4000-8000-000000000000', tenantId: T1, kind: 'TENANT', versions: [1], destroyedAt: '2026-10-22T00:00:00.000Z', auditSeq: '1', audit: null });
    const r = await init(deps(), [ext]);
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/already records 1 destruction.*never start a new one over it/);
    expect(readCopy(primary).state).toBe('missing');
  });

  it('[A2-3] a destination that cannot be created leaves nothing behind (no primary, so nothing half-made is authoritative)', async () => {
    mkdirSync(join(ext, 'something'), { recursive: true });
    expect((await init(deps(), [ext])).lines.join()).toMatch(/is not empty/);
    expect(readCopy(primary).state).toBe('missing');
  });
});

describe('[A2-3] init reconciles the history from before the ledger, or refuses (owner review of A2)', () => {
  it('[A2-3] a consistent history: each earlier destruction adopted (recorded, nothing destroyed), and genesis says what it cannot know', async () => {
    db.destroyedBeforeLedger(T1, [1]); // t1 offboarded under an older release: every key destroyed, audited
    const r = await init(deps(), [ext]);
    expect(r.ok, r.lines.join()).toBe(true);
    expect(r.lines.join('\n')).toMatch(/1 destruction\(s\) adopted from the database's evidence\. Destructions made before this ledger existed .*cannot be known/);
    const a = authority();
    if (!a.ok) throw new Error('not authoritative');
    const g = a.entries[0];
    expect(g?.type === 'genesis' && g.history).toMatchObject({ statement: expect.stringMatching(/not represented/), adopted: [{ tenant: { id: T1 }, kind: 'TENANT', versions: [1] }] });
    expect(a.entries.slice(1).map((e) => e.type)).toEqual(['pending', 'committed']);
    expect(a.entries[2]).toMatchObject({ by: 'adoption' });
    expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED' });
    // It is an accepted destruction from now on: a restore that brings the key back is undone by recovery.
    const older = new FakeKeysDb();
    older.addTenant(T1, 't1', { 1: 'ACTIVE' });
    older.addTenant(T2, 't2', { 1: 'ACTIVE' });
    db.restore(older.snapshot());
    expect((await recover(deps())).ok).toBe(true);
    expect(db.keysOf(T1)).toEqual({ 1: 'DESTROYED' });
  });

  it('[A2-3] no earlier destruction: genesis still says the history before it is what the database showed', async () => {
    expect((await init(deps())).ok).toBe(true);
    const a = authority();
    const g = a.ok ? a.entries[0] : undefined;
    expect(g?.type === 'genesis' && g.history).toMatchObject({ adopted: [], statement: expect.stringMatching(/cannot be known/) });
  });

  it.each<[string, () => void, RegExp]>([
    ['an audit event whose keys are live again (a restore undid it before the ledger)', () => db.legacyAudit({ tenantId: T1, versions: [1] }), /records the destruction of t1 v1, but that key is ACTIVE now/],
    ['a destroyed key no audit event records', () => db.destroyedBeforeLedger(T1, [1], { audited: false }), /t1 v1 is destroyed, but no audit event records its destruction/],
    ['a destroyed key whose wrap is not erased', () => db.destroyedBeforeLedger(T1, [1], { erased: false }), /DESTROYED but its wrap is not erased/],
    ['an audit event naming an op with no row', () => { db.destroyedBeforeLedger(T1, [1], { audited: false }); db.legacyAudit({ tenantId: T1, versions: [1], op: '30000000-0000-4000-8000-000000000000' }); }, /names op 30000000-0000-4000-8000-000000000000, but the database holds no key_destruction row/],
    ['an audit event without its tenant or versions', () => db.legacyAudit({ tenantId: null, versions: [] }), /without naming its tenant and versions/],
  ])('[A2-3] an inconsistent history refuses init, and nothing is created: %s', async (_name, make, why) => {
    make();
    const r = await init(deps(), [ext]);
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/can't be established, so no ledger was started/);
    expect(r.lines.join('\n')).toMatch(why);
    expect(readCopy(primary).state).toBe('missing');
    expect(db.calls.filter((c) => c.startsWith('adopt:'))).toHaveLength(0);
  });

  it('[A2-3][D13] init stopped right after genesis (no adoption pending yet): recovery completes genesis’s plan', async () => {
    db.destroyedBeforeLedger(T1, [1]);
    await expect(
      init(
        {
          ...deps(),
          crash: (p) => {
            if (p === 'init:genesis') throw new Error('crash');
          },
        },
        [ext],
      ),
    ).rejects.toThrow('crash');
    const before = authority();
    expect(before.ok && before.entries.map((e) => e.type)).toEqual(['genesis']);
    const rec = await recover(deps());
    expect(rec.ok, rec.lines.join('\n')).toBe(true);
    const after = authority();
    expect(after.ok && after.entries.map((e) => e.type)).toEqual(['genesis', 'pending', 'committed']);
    expect(after.ok && after.entries[2]).toMatchObject({ by: 'adoption' });
  });

  it('[A2-3] init stopped after genesis, before an adoption: recovery completes the plan, so none is left out', async () => {
    db.destroyedBeforeLedger(T1, [1]);
    let n = 0;
    const failingOnce: ProtocolDeps = { ...deps(), db: Object.assign(Object.create(db) as FakeKeysDb, { adopt: (...a: Parameters<FakeKeysDb['adopt']>) => (n++ === 0 ? Promise.resolve({ outcome: 'unknown' as const, detail: 'the job died' }) : db.adopt(...a)) }) };
    const r = await init(failingOnce, [ext]);
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/run `pnpm stack:keys recover`/);
    const rec = await recover(deps());
    expect(rec.ok, rec.lines.join('\n')).toBe(true);
    const a = authority();
    expect(a.ok && a.entries.at(-1)).toMatchObject({ type: 'committed', by: 'adoption' });
  });
});

describe('[BK16] the guarantee-preserving commands', () => {
  beforeEach(async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    expect((await destroy(deps(), { slug: 't1' })).ok).toBe(true);
  });

  it('[BK16] permitted: the primary lost, the external drive readable and consistent: rebuilt from it, then recovery proceeds with no waiver', async () => {
    rmSync(primary.path, { recursive: true });
    expect((await recover(deps())).ok).toBe(false);
    expect((await rebuildDestination(deps(), primary.path)).lines.join()).toMatch(/--from/);
    const r = await rebuildDestination(deps(), primary.path, ext);
    expect(r.ok, r.lines.join()).toBe(true);
    expect((await recover(deps())).ok).toBe(true);
    expect(db.audited).toContain('destination_rebuilt');
  });

  it('[BK16] permitted: an emptied, or swapped, external copy is rebuilt from the primary (a swapped one kept aside)', async () => {
    rmSync(ext, { recursive: true });
    mkdirSync(ext);
    expect((await rebuildDestination(deps(), ext)).ok).toBe(true);
    expect(authority().ok).toBe(true);
    // An older copy of itself swapped in: rebuilt, and the replaced copy kept aside for evidence.
    const ledgerDir = readdirSync(ext).find((n) => !n.startsWith('.')) ?? '';
    const older = join(root, 'older');
    cpSync(join(ext, ledgerDir), older, { recursive: true });
    expect((await destroy(deps(), { slug: 't2' })).ok).toBe(true);
    rmSync(join(ext, ledgerDir), { recursive: true });
    cpSync(older, join(ext, ledgerDir), { recursive: true });
    expect(authority().ok).toBe(false);
    expect((await rebuildDestination(deps(), ext)).ok).toBe(true);
    expect(authority().ok).toBe(true);
    expect(readdirSync(ext).some((n) => n.startsWith('.replaced-'))).toBe(true);
  });

  it('[BK16] permitted: the external drive gone for good, the primary readable: removed, and recovery proceeds', async () => {
    rmSync(ext, { recursive: true });
    expect((await removeDestination(deps(), ext, 'x')).lines.join()).toMatch(/a reason is required/);
    const r = await removeDestination(deps(), ext, 'the drive failed and was discarded');
    expect(r.ok, r.lines.join()).toBe(true);
    const a = authority();
    expect(a.ok && a.destinations.map((d) => d.id)).toEqual(['primary']);
    expect((await recover(deps())).ok).toBe(true);
    expect(db.audited).toContain('destination_removed');
  });

  it('[BK16] permitted: every destination readable and agreeing: recovery needs no owner step; a new destination can be added', async () => {
    expect((await recover(deps())).ok).toBe(true);
    const more = join(root, 'second-drive');
    expect((await addDestination(deps(), more)).ok).toBe(true);
    const a = authority();
    expect(a.ok && a.destinations).toHaveLength(3);
    expect((await destroy(deps(), { slug: 't2' })).ok).toBe(true);
    expect(status(deps()).lines.join('\n')).toMatch(/3 destination|2 committed/);
  });

  it('[BK16] rejected: rebuild or remove with no configured destination’s own copy readable', async () => {
    rmSync(primary.path, { recursive: true });
    rmSync(ext, { recursive: true });
    expect((await rebuildDestination(deps(), primary.path, ext)).ok).toBe(false);
    expect((await removeDestination(deps(), ext, 'the drive failed and was discarded')).ok).toBe(false);
  });

  it('[BK16] rejected: a backup set’s copy (or any copy that is not a configured destination’s own) as the source', async () => {
    const backupSet = join(root, 'backup-set', 'ledger');
    cpSync(ext, backupSet, { recursive: true }); // a snapshot: its identity still names the external destination
    rmSync(primary.path, { recursive: true });
    rmSync(ext, { recursive: true });
    const r = await rebuildDestination(deps(), primary.path, backupSet);
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/is not a configured destination of its ledger \(a backup set's or the bucket's copy can never be a source\)/);
    expect(readCopy(primary).state).toBe('missing');
  });

  it('[BK16] rejected: a source copy that lacks a key_destruction op the database holds', async () => {
    const before = join(root, 'ext-before');
    cpSync(ext, before, { recursive: true });
    expect((await destroy(deps(), { slug: 't2' })).ok).toBe(true);
    // The external drive swapped for its older self, and the primary lost: the source lacks t2's destruction.
    rmSync(ext, { recursive: true });
    cpSync(before, ext, { recursive: true });
    rmSync(primary.path, { recursive: true });
    const r = await rebuildDestination(deps(), primary.path, ext);
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/the database holds key_destruction op\(s\) this copy lacks.*would lose an accepted destruction/);
    expect(readCopy(primary).state).toBe('missing');
  });

  it('[BK16] rejected: removing a destination when the rest are not authoritative, or removing the primary', async () => {
    expect((await removeDestination(deps(), primary.path, 'the primary is in the way')).lines.join()).toMatch(/never removed/);
    rmSync(primary.path, { recursive: true });
    expect((await removeDestination(deps(), ext, 'the drive failed and was discarded')).ok).toBe(false);
  });

  it('[BK16] rejected: removing one destination while another of the rest is unreadable (the rest must stand on their own)', async () => {
    const second = join(root, 'second-drive');
    expect((await addDestination(deps(), second)).ok).toBe(true);
    rmSync(second, { recursive: true }); // the rest would be the primary and a missing drive
    const r = await removeDestination(deps(), ext, 'the drive failed and was discarded');
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/the remaining destinations are not authoritative: nothing removed/);
    const a = establishAuthority({ ...primary }, undefined, {});
    expect(a.ok).toBe(false); // still configured: nothing changed
    expect(destinationsOf(entriesOf(readCopy(primary)))).toHaveLength(3);
  });

  it('[BK16] every permitted command is a chained entry and a platform audit event', async () => {
    await addDestination(deps(), join(root, 'second-drive'));
    const a = authority();
    if (!a.ok) throw new Error('not authoritative');
    expect(a.entries.flatMap((e) => (e.type === 'config' ? [e.change] : []))).toEqual(['add']);
    expect(destinationsOf(a.entries)).toHaveLength(3);
    expect(db.audited).toEqual(['initialised', 'destination_added']);
  });
});
