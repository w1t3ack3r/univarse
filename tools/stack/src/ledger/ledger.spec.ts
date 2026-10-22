// Spec 0020 D7, D8 step 1, BK12, BK13, BK16: the chain, one destination's durability on the real file system, and
// the authoritative ledger. The protocol itself is protocol.spec.ts.
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, chainProblem, lineOf, nextEntry, opStates, parseLines, type Destination, type Entry, type EntryBody } from './chain.js';
import { agree, establishAuthority, Ledger, LedgerWriteError } from './ledger.js';
import { appendToCopy, copyDir, createCopy, makeRealFs, readCopy, realFs, type LedgerFs } from './store.js';

const LEDGER = '11111111-2222-4333-8444-555555555555';
const OP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let root: string;
let primary: Destination;
let external: Destination;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'uv-ledger-'));
  primary = { id: 'primary', path: join(root, 'primary') };
  external = { id: 'dest-ext', path: join(root, 'external') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function chain(...bodies: EntryBody[]): Entry[] {
  const out: Entry[] = [];
  for (const b of bodies) out.push(nextEntry(out.at(-1) ?? null, b, '2026-10-22T12:00:00.000Z'));
  return out;
}
const genesis = (destinations: Destination[] = [primary, external]): EntryBody => ({ type: 'genesis', ledgerId: LEDGER, generation: 1, destinations });
const pending = (op = OP): EntryBody => ({ type: 'pending', op, tenant: { id: 't', slug: 'tenant' }, kind: 'TENANT', versions: [1], requestedAt: '2026-10-22T12:00:00.000Z', preconditions: {} });
const committed = (op = OP): EntryBody => ({ type: 'committed', op, versions: [1], destroyedAt: '2026-10-22T12:00:01.000Z', auditSeq: '7', by: 'destroy' });
const ledgerFile = (d: Destination) => join(copyDir(d.path, LEDGER), 'ledger.jsonl');

describe('[D7] the chain', () => {
  it('[D7] canonical JSON: the same entry is the same bytes, whatever its key order', () => {
    expect(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('[D7] a chain verifies; it starts with genesis and holds no key material', () => {
    const c = chain(genesis(), pending(), committed());
    expect(chainProblem(c)).toBeNull();
    expect(c.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(c[1]?.prev).toBe(c[0]?.hash);
    expect(JSON.stringify(c)).not.toMatch(/vault:v\d|wrapped|dek/i);
  });

  it.each<[string, (c: Entry[]) => Entry[], RegExp]>([
    ['an edited entry', (c) => c.map((e, i) => (i === 1 ? ({ ...e, versions: [2] } as Entry) : e)), /hash does not match its content/],
    ['a deleted entry', (c) => [c[0]!, c[2]!], /seq 3 out of order/],
    ['reordered entries', (c) => [c[0]!, c[2]!, c[1]!], /out of order/],
    ['an entry re-hashed after an edit (its successor no longer chains)', (c) => {
      // The edited entry is given a fresh, valid hash of its own: the next entry's prev no longer matches it.
      return [c[0]!, nextEntry(c[0]!, { type: 'pending', op: OP, tenant: { id: 't', slug: 'tenant' }, kind: 'TENANT', versions: [9], requestedAt: '2026-10-22T12:00:00.000Z', preconditions: {} }, c[1]!.at), c[2]!];
    }, /prev does not match/],
    ['a second genesis', (c) => [...c, nextEntry(c[2]!, genesis())], /a second genesis/],
  ])('[BK12] %s does not verify', (_name, edit, why) => {
    expect(chainProblem(edit(chain(genesis(), pending(), committed())))).toMatch(why);
  });

  it('[BK12] a torn last line, or a line not in canonical form, is a problem, never skipped', () => {
    const text = chain(genesis(), pending()).map(lineOf).join('');
    expect(parseLines(text.slice(0, -5))).toEqual({ problem: 'the last line is incomplete (a torn write)' });
    expect(parseLines(text.replace('"type":"pending"', '"type": "pending"'))).toMatchObject({ problem: expect.stringMatching(/not in canonical form/) });
  });

  it('[D8] each op has one pending record and at most one outcome', () => {
    const c = chain(genesis(), pending(), committed(), { type: 'aborted', op: OP, reason: 'x' }, committed('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
    expect(opStates(c).problems).toEqual([`op ${OP}: a second outcome (seq 4)`, 'op bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb: a committed record with no pending record (seq 5)']);
  });
});

describe('[BK13] a destination: durable means written, fsynced, read back and verified', () => {
  it('[BK13] on the real file system, every write is fsynced before it counts, and read back whole', () => {
    const fsyncs: number[] = [];
    const counting = makeRealFs({ closeSync, fsyncSync: (fd) => {
        fsyncs.push(fd);
        fsyncSync(fd);
      }, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync });
    const c = chain(genesis([primary]), pending(), committed());
    expect(createCopy(primary, c.slice(0, 1), counting)).toBeNull();
    expect(fsyncs).toHaveLength(2); // the identity file and the ledger file
    expect(appendToCopy(primary, LEDGER, c.slice(0, 1), c.slice(1, 2), counting)).toBeNull();
    expect(appendToCopy(primary, LEDGER, c.slice(0, 2), c.slice(2), counting)).toBeNull();
    expect(fsyncs).toHaveLength(4); // one per append
    expect(readFileSync(ledgerFile(primary), 'utf8')).toBe(c.map(lineOf).join(''));
    expect(readCopy(primary)).toMatchObject({ state: 'ok', entries: c });
  });

  it('[BK13] a destination that accepts the write but returns different bytes is not durable', () => {
    const c = chain(genesis([primary]), pending());
    createCopy(primary, c.slice(0, 1));
    const lying: LedgerFs = { ...realFs, read: (p) => (p.endsWith('ledger.jsonl') && realFs.read(p)?.length !== lineOf(c[0]!).length ? Buffer.from(lineOf(c[0]!)) : realFs.read(p)) };
    expect(appendToCopy(primary, LEDGER, c.slice(0, 1), c.slice(1), lying)).toMatch(/read back different bytes than were written: not durable/);
  });

  it('[BK13] a write that fails, or a copy changed underneath since it was read, is reported, never retried', () => {
    const c = chain(genesis([primary]), pending(), committed());
    createCopy(primary, c.slice(0, 2));
    const failing: LedgerFs = { ...realFs, appendDurable: () => { throw new Error('EIO: i/o error'); } };
    expect(appendToCopy(primary, LEDGER, c.slice(0, 2), c.slice(2), failing)).toMatch(/the write failed: EIO/);
    expect(appendToCopy(primary, LEDGER, c.slice(0, 1), c.slice(2))).toMatch(/changed underneath/);
  });

  it.each<[string, () => void, string]>([
    ['missing (a drive not connected)', () => undefined, 'missing'],
    ['empty (recreated)', () => mkdirSync(external.path, { recursive: true }), 'empty'],
  ])('[BK16] a destination that is %s is reported as such', (_n, make, state) => {
    make();
    expect(readCopy(external).state).toBe(state);
  });

  it('[BK16] a copy swapped in from another destination (its identity names another id) is invalid', () => {
    createCopy(primary, chain(genesis()));
    mkdirSync(external.path, { recursive: true });
    // The primary's whole directory copied onto the external drive: its identity still says "primary".
    for (const n of readdirSync(primary.path)) renameSync(join(primary.path, n), join(external.path, n));
    expect(readCopy(external)).toMatchObject({ state: 'invalid', problem: expect.stringMatching(/it is destination primary, not dest-ext \(swapped\?\)/) });
  });
});

describe('[D8][BK16] the authoritative ledger', () => {
  const both = (entriesP: Entry[], entriesE: Entry[] = entriesP) => {
    expect(createCopy(primary, entriesP)).toBeNull();
    expect(createCopy(external, entriesE)).toBeNull();
  };

  it('[D8] every configured destination readable, verifying and equal: authoritative', () => {
    const c = chain(genesis(), pending(), committed());
    both(c);
    expect(establishAuthority(primary)).toMatchObject({ ok: true, ledgerId: LEDGER, entries: c });
  });

  it('[D8] a copy behind by the one record in flight (or a stopped pending and its aborted) agrees', () => {
    const c = chain(genesis(), pending(), { type: 'aborted', op: OP, reason: 'destination_unavailable' });
    expect(agree([{ dest: primary, entries: c }, { dest: external, entries: c.slice(0, 1) }])).toBeNull();
    expect(agree([{ dest: primary, entries: c }, { dest: external, entries: c.slice(0, 2) }])).toBeNull();
    const d = chain(genesis(), pending(), committed());
    // pending and its committed missing together: committed is written only once pending is everywhere.
    expect(agree([{ dest: primary, entries: d }, { dest: external, entries: d.slice(0, 1) }])).toMatch(/out of step/);
  });

  it('[D8] the copy behind is levelled from the verified entries', () => {
    const c = chain(genesis(), pending(), committed());
    both(c, c.slice(0, 2));
    const opened = Ledger.open(primary);
    if (!('ledger' in opened)) throw new Error(opened.problems.join());
    expect(opened.ledger.level()).toEqual([]);
    expect(readFileSync(ledgerFile(external), 'utf8')).toBe(c.map(lineOf).join(''));
  });

  it.each<[string, () => void, RegExp]>([
    ['the primary lost (deleted), the external drive unreachable, an older valid copy at hand', () => {
      const c = chain(genesis(), pending(), committed());
      both(c);
      rmSync(primary.path, { recursive: true });
      rmSync(external.path, { recursive: true });
      // A backup set's copy of the ledger: valid, older, and never read.
      createCopy({ id: 'primary', path: join(root, 'backup-set', 'ledger') }, c.slice(0, 1));
    }, /primary copy .* is missing/],
    ['the primary recreated empty', () => {
      both(chain(genesis()));
      rmSync(primary.path, { recursive: true });
      mkdirSync(primary.path);
    }, /primary copy .* is empty/],
    ['the external drive not connected', () => {
      both(chain(genesis()));
      rmSync(external.path, { recursive: true });
    }, /configured destination dest-ext .* is unreadable or missing/],
    ['a destination swapped for an older copy of itself (behind by more than one op)', () => {
      const two = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const c = chain(genesis(), pending(), committed(), pending(two), committed(two));
      both(c, c.slice(0, 3));
    }, /out of step: behind by 2 entries, more than the one operation/],
    ['copies that diverge', () => {
      const base = chain(genesis());
      const a = [...base, nextEntry(base[0]!, pending())];
      const b = [...base, nextEntry(base[0]!, pending('dddddddd-dddd-4ddd-8ddd-dddddddddddd'))];
      both(a, b);
    }, /diverge at seq 2/],
    ["a copy whose genesis doesn't match (another ledger)", () => {
      createCopy(primary, chain(genesis()));
      createCopy(external, [nextEntry(null, { type: 'genesis', ledgerId: '99999999-9999-4999-8999-999999999999', generation: 1, destinations: [external] })]);
    }, /does not verify|another ledger|different ledgers/],
    ['a configured destination missing from the configuration of the copies (an edited chain)', () => {
      const c = chain(genesis());
      both(c);
      const text = readFileSync(ledgerFile(external), 'utf8');
      writeFileSync(ledgerFile(external), text.replace('"generation":1', '"generation":2'));
    }, /hash does not match/],
  ])('[BK16] blocked: %s', (_name, make, why) => {
    make();
    const a = establishAuthority(primary);
    expect(a.ok).toBe(false);
    expect(a.ok ? '' : a.problems.join('\n')).toMatch(why);
  });

  it('[D8] agreement allows exactly one config entry in flight, or entries of one op; never a mix', () => {
    const c = chain(genesis(), pending(), committed(), { type: 'config', change: 'add', destination: external, destinations: [primary, external] });
    expect(agree([{ dest: primary, entries: c }, { dest: external, entries: c.slice(0, 3) }])).toBeNull();
    expect(agree([{ dest: primary, entries: c }, { dest: external, entries: c.slice(0, 1) }])).toMatch(/out of step/);
  });

  it('[BK13] a destination that fails mid-append is named, and the entry counts only where it is durable', () => {
    const c = chain(genesis());
    both(c);
    const failing: LedgerFs = { ...realFs, appendDurable: (p, d) => (p.startsWith(external.path) ? (() => { throw new Error('ENOSPC'); })() : realFs.appendDurable(p, d)) };
    const opened = Ledger.open(primary, { fs: failing });
    if (!('ledger' in opened)) throw new Error('not authoritative');
    let err: unknown;
    try {
      opened.ledger.append(pending());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LedgerWriteError);
    expect((err as LedgerWriteError).written).toEqual(['primary']);
    expect((err as LedgerWriteError).problem).toMatch(/ENOSPC/);
  });
});
