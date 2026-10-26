// Spec 0020 B2-10: a rehearsal's recovery appends to its scratch copies, and the real ledger stays byte for byte as it
// was; a destination left unmapped can't be written, so it fails the recovery instead of reaching a real file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTree } from '../backup/ledger-snapshot.js';
import type { Destination } from '../ledger/chain.js';
import { init } from '../ledger/commands.js';
import { FakeKeysDb } from '../ledger/fake-keys-db.js';
import { destroy, recover, type ProtocolDeps } from '../ledger/protocol.js';
import { copyToScratch, mapPath, realHeads, remappedFs, ScratchWriteRefused } from './scratch-ledger.js';

const T3 = '10000000-0000-4000-8000-000000000003';

let root: string;
let primary: Destination;
let external: string;
let db: FakeKeysDb;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-scratch-'));
  primary = { id: 'primary', path: join(root, 'primary') };
  external = join(root, 'external');
  db = new FakeKeysDb();
  db.addTenant(T3, 't3', { 1: 'ACTIVE' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = (over: Partial<ProtocolDeps> = {}): ProtocolDeps => ({ primary, db, lock: () => Promise.resolve({ release: () => undefined }), log: () => undefined, ...over });
/** Every file under both real destinations, by path, as bytes. */
const realFiles = () => Object.fromEntries([primary.path, external].flatMap((p) => readTree(p, p).map((e) => [`${p}:${e.name}`, e.data.toString('base64')])));

/** A ledger with one accepted destruction (t3), and a database restored from before it: recovery must re-apply it. */
async function restoredFromBefore(): Promise<void> {
  expect((await init(deps(), [external])).ok).toBe(true);
  const before = db.snapshot();
  expect((await destroy(deps(), { slug: 't3' })).ok).toBe(true);
  db.restore(before);
}

describe('[B2-10] the scratch ledger', () => {
  it('recovery re-applies the destruction in the scratch copies; the real ledger is byte-identical, and its heads unchanged', async () => {
    await restoredFromBefore();
    const files = realFiles();
    const heads = realHeads(primary);
    const scratch = join(root, 'scratch');
    const copied = copyToScratch(primary, scratch);
    if (!copied.ok) throw new Error(copied.problems.join('\n'));
    // Each destination's copy under its own id: the primary's, and the added one's generated id.
    expect(copied.map.find((m) => m.from === primary.path)?.to).toBe(join(scratch, 'primary'));
    expect(copied.map.find((m) => m.from === external)?.to).toMatch(/[\\/]scratch[\\/]dest-[0-9a-f]+$/);

    const rec = await recover(deps({ fs: remappedFs(copied.map) }));
    expect(rec.ok).toBe(true);
    expect(rec.lines.join('\n')).toMatch(/re-applied after a restore/);
    expect(db.keysOf(T3)).toEqual({ 1: 'DESTROYED' });
    // The scratch copies gained the record...
    for (const m of copied.map) expect(readTree(m.to, m.to).some((e) => e.data.toString('utf8').includes('"type":"reapplied"'))).toBe(true);
    // ...and the real ones did not.
    expect(realFiles()).toEqual(files);
    const after = realHeads(primary);
    expect(heads.ok && after.ok && after.key === heads.key).toBe(true);
  });

  it('a destination left unmapped is never written: recovery stops, and the real files are unchanged', async () => {
    await restoredFromBefore();
    const files = realFiles();
    const copied = copyToScratch(primary, join(root, 'scratch'));
    if (!copied.ok) throw new Error('not copied');
    const partial = copied.map.filter((m) => !m.from.endsWith('external'));
    const rec = await recover(deps({ fs: remappedFs(partial) }));
    expect(rec.ok).toBe(false);
    expect(rec.lines.join('\n')).toMatch(/a rehearsal may write only its scratch ledger/);
    expect(realFiles()).toEqual(files);
  });

  it('nothing is copied from a ledger whose authority can’t be established', async () => {
    expect((await init(deps(), [external])).ok).toBe(true);
    rmSync(external, { recursive: true });
    const copied = copyToScratch(primary, join(root, 'scratch'));
    expect(copied.ok).toBe(false);
    expect(readTree(root, root).some((e) => e.name.startsWith('scratch/'))).toBe(false);
  });
});

describe('[B2-10] mapping a path', () => {
  const map = [{ from: 'C:\\Users\\o\\.univarse\\ledger', to: 'C:\\tmp\\scratch\\primary' }];

  it('maps the root and everything under it, without case on Windows', () => {
    expect(mapPath('C:\\Users\\o\\.univarse\\ledger', map, 'win32')).toBe('C:\\tmp\\scratch\\primary');
    expect(mapPath('c:\\users\\O\\.UNIVARSE\\Ledger\\abc\\gen-0001\\ledger.jsonl', map, 'win32')?.toLowerCase()).toBe(join('C:\\tmp\\scratch\\primary', 'abc', 'gen-0001', 'ledger.jsonl').toLowerCase());
  });

  it('never maps a sibling that merely starts with the same name', () => {
    expect(mapPath('C:\\Users\\o\\.univarse\\ledger-old\\x', map, 'win32')).toBeNull();
  });

  it('refuses a write it can’t map, and reads it through unchanged', () => {
    const seen: string[] = [];
    const base = { read: (p: string) => (seen.push(p), null), list: () => null, mkdirp: () => undefined, appendDurable: () => undefined, replaceDurable: () => undefined, remove: () => undefined, rename: () => undefined };
    const fs = remappedFs([{ from: join(root, 'a'), to: join(root, 'b') }], base);
    expect(() => fs.appendDurable(join(root, 'elsewhere', 'f'), Buffer.from('x'))).toThrow(ScratchWriteRefused);
    expect(() => fs.rename(join(root, 'a', 'f'), join(root, 'elsewhere', 'f'))).toThrow(ScratchWriteRefused);
    fs.read(join(root, 'a', 'f'));
    expect(seen).toEqual([join(root, 'b', 'f')]);
  });
});
