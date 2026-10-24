// Spec 0020 B-8, D14: a set's ledger copy is taken only from an established authority, in a destination's layout, and
// is a prefix of the live ledger ending at the recorded seq and hash.
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Destination } from '../ledger/chain.js';
import { init } from '../ledger/commands.js';
import { FakeKeysDb } from '../ledger/fake-keys-db.js';
import { establishAuthority } from '../ledger/ledger.js';
import { destroy, type ProtocolDeps } from '../ledger/protocol.js';
import { snapshotLedger } from './ledger-snapshot.js';

const T1 = '10000000-0000-4000-8000-000000000001';
let root: string;
let primary: Destination;
let ext: string;
let db: FakeKeysDb;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-snap-'));
  primary = { id: 'primary', path: join(root, 'primary') };
  ext = join(root, 'external');
  db = new FakeKeysDb();
  db.addTenant(T1, 't1', { 1: 'ACTIVE' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const deps = (): ProtocolDeps => ({ primary, db, lock: () => Promise.resolve({ release: () => undefined }), log: () => undefined });

describe('snapshotLedger', () => {
  it('copies the authoritative ledger in a destination\'s layout, ending at the live head', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    expect((await destroy(deps(), { slug: 't1' })).ok).toBe(true);
    const s = snapshotLedger(primary);
    if (!s.ok) throw new Error(s.problems.join());
    const a = establishAuthority(primary);
    if (!a.ok) throw new Error('no authority');
    const last = a.entries.at(-1);
    expect(s.snapshot).toMatchObject({ ledgerId: a.ledgerId, generation: 1, attempt: null, seq: last?.seq, hash: last?.hash, destinations: 2 });
    expect(s.entries.map((e) => e.name).sort()).toEqual([`${a.ledgerId}/gen-0001/destination.json`, `${a.ledgerId}/gen-0001/ledger.jsonl`]);
    expect(s.entries.find((e) => e.name.endsWith('ledger.jsonl'))?.data.toString('utf8').trimEnd().split('\n')).toHaveLength(a.entries.length);
  });

  it('refuses when authority can\'t be established: a configured destination missing', async () => {
    expect((await init(deps(), [ext])).ok).toBe(true);
    rmSync(ext, { recursive: true, force: true });
    const s = snapshotLedger(primary);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.problems.join('\n')).toMatch(/authority can't be established[\s\S]*external/);
  });

  it('refuses a chain edited on the primary', async () => {
    expect((await init(deps(), [])).ok).toBe(true);
    const a = establishAuthority(primary);
    if (!a.ok) throw new Error('no authority');
    appendFileSync(join(primary.path, a.ledgerId, 'gen-0001', 'ledger.jsonl'), '{"not":"an entry"}\n');
    expect(snapshotLedger(primary).ok).toBe(false);
  });

  it('never copies the lock or the bucket copy\'s progress record', async () => {
    expect((await init(deps(), [])).ok).toBe(true);
    const a = establishAuthority(primary);
    if (!a.ok) throw new Error('no authority');
    appendFileSync(join(primary.path, a.ledgerId, '.bucket-copied.json'), '{}');
    const s = snapshotLedger(primary);
    if (!s.ok) throw new Error(s.problems.join());
    expect(s.entries.some((e) => e.name.includes('.bucket') || e.name.includes('.lock'))).toBe(false);
  });
});
