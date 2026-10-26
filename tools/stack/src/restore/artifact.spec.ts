// Spec 0020 B2-6 steps 1 and 3, on a real sealed set written by the backup's own SetWriter: it opens with its key,
// every artifact streams back exactly, and a changed file, a wrong record, the wrong key or an incomplete set is
// refused (BK10: an artifact's hash not checked).
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INDEX, SETS, SetWriter } from '../backup/set.js';
import { tarStream } from '../backup/tar.js';
import { ArtifactMismatch, openArtifact, openSet, readAll } from './artifact.js';

let root: string;
const pair = () => generateKeyPairSync('x25519');
let keys: ReturnType<typeof pair>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-artifact-'));
  keys = pair();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const PG = Buffer.alloc(300_000, 7);
async function aSet(id = '20261026T020000Z-ab12', complete = true) {
  const w = new SetWriter(root, id, keys.publicKey);
  await w.add('postgres.tar', Readable.from([PG]));
  await w.add('stack.tar', tarStream([{ name: 'secrets.json', data: Buffer.from('{}') }, { name: 'certs/ca.crt', data: Buffer.from('ca') }]));
  if (complete) await w.complete({ format: 'univarse-backup-manifest-v1', createdAt: '2026-10-26T02:00:00Z', ledger: { ledgerId: 'l', generation: 1, seq: 2, hash: 'h' } }, { createdAt: new Date('2026-10-26T02:00:00Z'), startWal: '000000010000000000000004', timeline: 1 });
  return { id, w };
}

describe('[B2-6] opening a set', () => {
  it('the newest complete set opens with its key; every artifact streams back exactly; a tar artifact lists its files', async () => {
    await aSet('20261025T020000Z-0000');
    await aSet('20261026T020000Z-ab12');
    const o = await openSet(root, undefined, keys.privateKey);
    if (!o.ok) throw new Error(o.problems.join('\n'));
    expect(o.set.index.setId).toBe('20261026T020000Z-ab12');
    expect((await readAll(o.set.artifact('postgres.tar'))).equals(PG)).toBe(true);
    expect((await o.set.files('stack.tar')).map((f) => f.name)).toEqual(['secrets.json', 'certs/ca.crt']);
  });

  it('a named set, an unknown one, and an incomplete one', async () => {
    await aSet('20261025T020000Z-0000');
    await aSet('20261026T020000Z-ab12', false);
    expect((await openSet(root, '20261025T020000Z-0000', keys.privateKey)).ok).toBe(true);
    expect(await openSet(root, '20261024T020000Z-ffff', keys.privateKey)).toEqual({ ok: false, problems: [`no set 20261024T020000Z-ffff in ${root}`] });
    expect(await openSet(root, '20261026T020000Z-ab12', keys.privateKey)).toEqual({ ok: false, problems: ['set 20261026T020000Z-ab12 is incomplete (no index): it can\'t be restored'] });
  });

  it('a sealed file changed on disk is refused before the key is used', async () => {
    const { id } = await aSet();
    appendFileSync(join(root, SETS, id, 'stack.tar.seal'), 'x');
    const o = await openSet(root, id, keys.privateKey);
    expect(o).toEqual({ ok: false, problems: [`${id}/stack.tar.seal: differs from its index`] });
  });

  it('the wrong key opens nothing', async () => {
    const { id } = await aSet();
    const o = await openSet(root, id, pair().privateKey);
    expect(o.ok).toBe(false);
    expect(!o.ok && o.problems.join()).toMatch(/does not open with this key/);
  });

  it('an artifact whose plaintext differs from its record fails at its end, and so does a wrong size', async () => {
    const { id, w } = await aSet();
    const rec = w.records.find((r) => r.name === 'postgres.tar.seal');
    if (!rec) throw new Error('no record');
    const path = join(root, SETS, id, 'postgres.tar.seal');
    await expect(readAll(openArtifact(path, { ...rec, plainSha256: '0'.repeat(64) }, keys.privateKey))).rejects.toThrow(ArtifactMismatch);
    await expect(readAll(openArtifact(path, { ...rec, plainSize: rec.plainSize + 1 }, keys.privateKey))).rejects.toThrow(ArtifactMismatch);
    expect((await readAll(openArtifact(path, rec, keys.privateKey))).length).toBe(PG.length);
  });

  it('the index is the completion marker: a set without one is never chosen as the newest', async () => {
    await aSet('20261025T020000Z-0000');
    await aSet('20261026T020000Z-ab12', false);
    const o = await openSet(root, undefined, keys.privateKey);
    expect(o.ok && o.set.index.setId).toBe('20261025T020000Z-0000');
    rmSync(join(root, SETS, '20261025T020000Z-0000', INDEX));
    expect(await openSet(root, undefined, keys.privateKey)).toEqual({ ok: false, problems: [`no complete backup set in ${root}`] });
  });
});
