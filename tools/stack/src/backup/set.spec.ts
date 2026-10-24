// Spec 0020 B-6, B-13, BK3, BK8: a set's files are sealed, durable and indexed last; pruning keeps what it must.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { isoWeek, planPrune, prune, walToDelete } from './prune.js';
import { unseal } from './seal.js';
import { INDEX, listSets, MANIFEST, newSetId, realSetFs, SETS, SetWriter, verifySealedFiles, type SetFs, type SetIndex, type SetOnDisk } from './set.js';

const keys = () => {
  const k = generateKeyPairSync('x25519');
  return { pub: k.publicKey, priv: k.privateKey };
};
const dest = () => mkdtempSync(join(tmpdir(), 'uv-set-'));
const WAL0 = '000000010000000000000003';

describe('SetWriter', () => {
  it('writes sealed artifacts, a sealed manifest, and the clear index last', async () => {
    const { pub, priv } = keys();
    const d = dest();
    const id = newSetId(new Date('2026-10-24T10:15:00Z'));
    const w = new SetWriter(d, id, pub);
    const secret = Buffer.from('postgres-superuser-password-in-the-stack-tar-0123456789');
    const data = Buffer.concat([randomBytes(200_000), secret]);
    const a = await w.add('stack.tar', Readable.from([data]));
    expect(existsSync(join(d, SETS, id, INDEX))).toBe(false); // not complete until the index
    const idx = await w.complete({ checkpoint: { platform: { seq: 7 } } }, { createdAt: new Date('2026-10-24T10:15:00Z'), startWal: WAL0, timeline: 1 });

    const files = readdirSync(join(d, SETS, id)).sort();
    expect(files).toEqual([INDEX, MANIFEST, 'stack.tar.seal'].sort());
    const sealed = readFileSync(join(d, SETS, id, 'stack.tar.seal'));
    expect(sealed.includes(secret)).toBe(false);
    expect((await unseal(sealed, priv)).equals(data)).toBe(true);
    const manifest = JSON.parse((await unseal(readFileSync(join(d, SETS, id, MANIFEST)), priv)).toString('utf8')) as { setId: string; artifacts: { plainSha256: string }[]; checkpoint: unknown };
    expect(manifest.setId).toBe(id);
    expect(manifest.artifacts[0]?.plainSha256).toBe(a.plainSha256);
    expect(manifest.checkpoint).toEqual({ platform: { seq: 7 } });

    // The clear index: what prune and status need, and nothing from the manifest.
    const text = readFileSync(join(d, SETS, id, INDEX), 'utf8');
    expect(text).not.toContain(a.plainSha256);
    expect(text).not.toContain('checkpoint');
    expect(JSON.parse(text)).toEqual(idx);
    expect(await verifySealedFiles(d, idx)).toEqual([]);
  });

  it('a set without its index is incomplete, and listed as such', async () => {
    const { pub } = keys();
    const d = dest();
    const w = new SetWriter(d, newSetId(new Date()), pub);
    await w.add('vault.snap', Readable.from([Buffer.from('x')]));
    expect(listSets(d).map((s) => s.index)).toEqual([null]);
  });

  it('verifySealedFiles finds a changed, a truncated and a missing file', async () => {
    const { pub } = keys();
    const d = dest();
    const id = newSetId(new Date());
    const w = new SetWriter(d, id, pub);
    for (const n of ['a.tar', 'b.tar', 'c.tar']) await w.add(n, Readable.from([randomBytes(1000)]));
    const idx = await w.complete({}, { createdAt: new Date(), startWal: WAL0, timeline: 1 });
    const p = (n: string) => join(d, SETS, id, n);
    const a = readFileSync(p('a.tar.seal'));
    a[300] = (a[300] ?? 0) ^ 1;
    writeFileSync(p('a.tar.seal'), a);
    writeFileSync(p('b.tar.seal'), readFileSync(p('b.tar.seal')).subarray(1));
    realSetFs.remove(p('c.tar.seal'));
    expect(await verifySealedFiles(d, idx)).toEqual([`${id}/a.tar.seal: differs from its index`, `${id}/b.tar.seal: differs from its index`, `${id}/c.tar.seal: missing or unreadable`]);
  });

  it('fsyncs every file, and refuses one whose read-back differs, leaving nothing under its name', async () => {
    const { pub } = keys();
    const d = dest();
    let fsyncs = 0;
    let lie = false;
    const fs: SetFs = {
      ...realSetFs,
      fsync: (fd) => {
        fsyncs++;
        realSetFs.fsync(fd);
      },
      readHash: async (p) => (lie ? { sha256: '00'.repeat(32), size: 1 } : realSetFs.readHash(p)),
    };
    const id = newSetId(new Date());
    const w = new SetWriter(d, id, pub, fs);
    await w.add('a.tar', Readable.from([Buffer.from('a')]));
    await w.complete({}, { createdAt: new Date(), startWal: WAL0, timeline: 1 });
    expect(fsyncs).toBe(3); // the artifact, the manifest, the index

    lie = true;
    const id2 = newSetId(new Date(Date.now() + 1000));
    const w2 = new SetWriter(d, id2, pub, fs);
    await expect(w2.add('a.tar', Readable.from([Buffer.from('a')]))).rejects.toThrow(/not durable/);
    expect(readdirSync(join(d, SETS, id2))).toEqual([]);
  });

  it('an index whose read-back differs leaves the set incomplete', async () => {
    const { pub } = keys();
    const d = dest();
    const fs: SetFs = { ...realSetFs, readHash: async (p) => (p.endsWith(`${INDEX}.partial`) ? { sha256: '00'.repeat(32), size: 0 } : realSetFs.readHash(p)) };
    const id = newSetId(new Date());
    const w = new SetWriter(d, id, pub, fs);
    await w.add('a.tar', Readable.from([Buffer.from('a')]));
    await expect(w.complete({}, { createdAt: new Date(), startWal: WAL0, timeline: 1 })).rejects.toThrow(/not durable/);
    expect(existsSync(join(d, SETS, id, INDEX))).toBe(false);
    expect(listSets(d).map((s) => s.index)).toEqual([null]);
  });

  it('an index of another format, another set, or not complete counts as none', async () => {
    const { pub } = keys();
    const d = dest();
    const id = newSetId(new Date());
    const w = new SetWriter(d, id, pub);
    await w.add('a.tar', Readable.from([Buffer.from('a')]));
    const idx = await w.complete({}, { createdAt: new Date(), startWal: WAL0, timeline: 1 });
    const p = join(d, SETS, id, INDEX);
    for (const bad of [{ ...idx, format: 'other' }, { ...idx, setId: newSetId(new Date(0)) }, { ...idx, complete: false }, 'not json']) {
      writeFileSync(p, typeof bad === 'string' ? bad : JSON.stringify(bad));
      expect(listSets(d)[0]?.index).toBeNull();
    }
  });

  it('a failing source leaves nothing under the artifact name', async () => {
    const { pub } = keys();
    const d = dest();
    const id = newSetId(new Date());
    const w = new SetWriter(d, id, pub);
    async function* failing() {
      yield Buffer.from('partial');
      throw new Error('pg_basebackup exited 1');
    }
    await expect(w.add('postgres.tar', failing())).rejects.toThrow(/pg_basebackup/);
    expect(readdirSync(join(d, SETS, id))).toEqual([]);
  });
});

// ── Pruning ────────────────────────────────────────────────────────────────────────────────────────────────────

const day = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 2, 0, 0));
function setAt(d: Date, complete = true, startWal = WAL0): SetOnDisk {
  const setId = newSetId(d);
  const index: SetIndex | null = complete ? { format: 'univarse-backup-set-v1', setId, createdAt: d.toISOString(), complete: true, startWal, timeline: 1, keyFingerprint: '', files: [] } : null;
  return { setId, createdAt: d, index };
}

describe('isoWeek', () => {
  it('follows ISO 8601 at the year boundary', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01'); // a Thursday
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // a Friday: still 2026's last week
    expect(isoWeek(new Date('2026-10-25T23:59:59Z'))).toBe('2026-W43'); // a Sunday
    expect(isoWeek(new Date('2026-10-26T00:00:00Z'))).toBe('2026-W44'); // the Monday after
  });
});

describe('planPrune', () => {
  it('a daily schedule over 60 days keeps 7 dailies and the newest of 4 weeks, and the WAL from the oldest kept', () => {
    const sets = Array.from({ length: 60 }, (_, i) => setAt(day(i), true, `0000000100000000000000${(i + 16).toString(16).toUpperCase().padStart(2, '0')}`));
    const plan = planPrune(sets, day(60));
    const kept = sets.filter((s) => plan.keep.includes(s.setId));
    // The 7 newest (Nov 23–29) are one ISO week (W48); the weeklies are the newest of W47, W46, W45 and W44.
    expect(kept.length).toBe(11);
    expect([...new Set(kept.map((s) => isoWeek(s.createdAt)))]).toEqual(['2026-W44', '2026-W45', '2026-W46', '2026-W47', '2026-W48']);
    const oldest = kept[0];
    // D6's boundary: about 35 days (here 28, the oldest weekly being a Sunday).
    expect((day(59).getTime() - (oldest?.createdAt.getTime() ?? 0)) / 86_400_000).toBe(28);
    expect(plan.walFrom).toBe(oldest?.index?.startWal);
    expect(plan.deleteSets.length).toBe(49);
    // Every kept week's newest set is kept.
    for (const w of new Set(kept.map((s) => isoWeek(s.createdAt)))) {
      const newestOfWeek = sets.filter((s) => isoWeek(s.createdAt) === w).at(-1);
      expect(plan.keep).toContain(newestOfWeek?.setId);
    }
  });

  it('never deletes the newest complete set, even alone and old', () => {
    const only = setAt(day(0));
    expect(planPrune([only], day(400)).deleteSets).toEqual([]);
  });

  it('when the dailies span two weeks, both are excluded from the weeklies', () => {
    // Wednesday Oct 21 to Tuesday Oct 27: W43 and W44 hold dailies, so the weeklies are W42, W41, W40 and W39.
    const sets = Array.from({ length: 40 }, (_, i) => setAt(new Date(Date.UTC(2026, 8, 18 + i, 2))));
    const plan = planPrune(sets, new Date(Date.UTC(2026, 9, 28)));
    const weeks = [...new Set(sets.filter((s) => plan.keep.includes(s.setId)).map((s) => isoWeek(s.createdAt)))];
    expect(weeks).toEqual(['2026-W39', '2026-W40', '2026-W41', '2026-W42', '2026-W43', '2026-W44']);
    const oldest = sets.find((s) => plan.keep.includes(s.setId));
    expect(oldest?.createdAt.toISOString()).toBe('2026-09-27T02:00:00.000Z'); // W39's Sunday: 30 days back
  });

  it('keeps exactly 7 when they are all in one week, and drops the 8th', () => {
    const sets = Array.from({ length: 8 }, (_, i) => setAt(new Date(Date.UTC(2026, 9, 19, i, 0, 0)))); // Monday, hourly
    const plan = planPrune(sets, new Date(Date.UTC(2026, 9, 19, 12)));
    expect(plan.deleteSets).toEqual([sets[0]?.setId]);
  });

  it('removes incomplete sets older than a day, and keeps a newer one', () => {
    const sets = [setAt(day(10)), setAt(day(8), false), setAt(new Date(day(10).getTime() + 3600_000), false)];
    expect(planPrune(sets, new Date(day(10).getTime() + 7200_000)).deleteSets).toEqual([sets[1]?.setId]);
  });

  it('deletes no WAL while no complete set exists', () => {
    expect(planPrune([setAt(day(0), false)], day(5)).walFrom).toBeNull();
    expect(walToDelete([{ timeline: '00000001', name: '000000010000000000000001.gz.seal' }], null)).toEqual([]);
  });
});

describe('walToDelete', () => {
  const f = (name: string, timeline = '00000001') => ({ timeline, name });
  it('deletes segments numbered below the start, on any timeline, and keeps the start, later ones and history', () => {
    const files = [f('000000010000000000000002.gz.seal'), f('000000010000000000000003.gz.seal'), f('0000000100000001000000A0.gz.seal'), f('000000020000000000000001.gz.seal', '00000002'), f('00000002.history.seal', '00000002'), f('000000010000000000000002.gz.seal.partial')];
    expect(walToDelete(files, '000000020000000000000003')).toEqual([join('00000001', '000000010000000000000002.gz.seal'), join('00000002', '000000020000000000000001.gz.seal')]);
  });
});

describe('prune', () => {
  it('removes what the plan says, and nothing else', async () => {
    const { pub } = keys();
    const d = dest();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const id = newSetId(new Date(Date.UTC(2026, 9, 19, i)));
      ids.push(id);
      const w = new SetWriter(d, id, pub);
      await w.add('a.tar', Readable.from([Buffer.from('a')]));
      await w.complete({}, { createdAt: new Date(Date.UTC(2026, 9, 19, i)), startWal: `00000001000000000000000${String(i + 1)}`, timeline: 1 });
    }
    mkdirSync(join(d, 'wal', '00000001'), { recursive: true });
    for (let i = 1; i <= 9; i++) writeFileSync(join(d, 'wal', '00000001', `00000001000000000000000${String(i)}.gz.seal`), 'x');
    const lines = prune(d, new Date(Date.UTC(2026, 9, 19, 12)));
    expect(listSets(d).map((s) => s.setId)).toEqual(ids.slice(2));
    expect(readdirSync(join(d, 'wal', '00000001')).sort()).toEqual(['000000010000000000000003.gz.seal', '000000010000000000000004.gz.seal', '000000010000000000000005.gz.seal', '000000010000000000000006.gz.seal', '000000010000000000000007.gz.seal', '000000010000000000000008.gz.seal', '000000010000000000000009.gz.seal']);
    expect(lines).toEqual([`pruned set ${String(ids[0])}`, `pruned set ${String(ids[1])}`, 'pruned 2 WAL segments older than 000000010000000000000003']);
  });
});
