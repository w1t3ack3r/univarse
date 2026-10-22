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
