// Spec 0020 D7, BK13: one destination's copy of the ledger, and what "durable" means for it (A2-4): the bytes appended,
// fsync'd and closed, then the whole copy read back, its chain verified, and the appended lines found byte for byte.
// The file system is an interface, so a destination that accepts a write and returns other bytes can be tested.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { chainProblem, ledgerIdOf, lineOf, parseLines, type Destination, type Entry } from './chain.js';

export interface LedgerFs {
  /** The file's bytes, or null when it doesn't exist. */
  read(path: string): Buffer | null;
  /** Names in a directory, or null when it doesn't exist. */
  list(path: string): string[] | null;
  mkdirp(path: string): void;
  /** Appends, fsyncs and closes; creates the file when missing. */
  appendDurable(path: string, data: Buffer): void;
  /** Writes a whole new file through a temporary name (fsync'd), then renames it into place. */
  replaceDurable(path: string, data: Buffer): void;
  remove(path: string): void;
  rename(from: string, to: string): void;
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** The Node functions the real file system uses: injectable, so a test can count the fsyncs on a real disk (BK13). */
export interface NodeFs {
  readonly closeSync: typeof closeSync;
  readonly fsyncSync: typeof fsyncSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly openSync: typeof openSync;
  readonly readdirSync: typeof readdirSync;
  readonly readFileSync: typeof readFileSync;
  readonly renameSync: typeof renameSync;
  readonly rmSync: typeof rmSync;
  readonly writeSync: typeof writeSync;
}

export function makeRealFs(n: NodeFs = { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync }): LedgerFs {
  const writeAll = (fd: number, data: Buffer) => {
    let off = 0;
    while (off < data.length) off += n.writeSync(fd, data, off);
  };
  return {
    read: (p) => {
      try {
        return n.readFileSync(p);
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    list: (p) => {
      try {
        return n.readdirSync(p);
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    mkdirp: (p) => void n.mkdirSync(p, { recursive: true, mode: 0o700 }),
    appendDurable: (p, data) => {
      const fd = n.openSync(p, 'a', 0o600);
      try {
        writeAll(fd, data);
        n.fsyncSync(fd);
      } finally {
        n.closeSync(fd);
      }
    },
    replaceDurable: (p, data) => {
      const tmp = `${p}.tmp-${String(process.pid)}`;
      const fd = n.openSync(tmp, 'w', 0o600);
      try {
        writeAll(fd, data);
        n.fsyncSync(fd);
      } finally {
        n.closeSync(fd);
      }
      n.renameSync(tmp, p);
    },
    remove: (p) => n.rmSync(p, { recursive: true, force: true }),
    rename: (a, b) => n.renameSync(a, b),
  };
}

export const realFs: LedgerFs = makeRealFs();

/** A destination's own record of what it is: the ledger it belongs to and its id in that ledger's configuration. */
export interface Identity {
  readonly ledgerId: string;
  readonly destinationId: string;
}

export const LOCK_DIR = '.lock';
export const GENERATION_DIR = 'gen-0001'; // A3's waiver starts later generations in fresh directories
const LEDGER_FILE = 'ledger.jsonl';
const IDENTITY_FILE = 'destination.json';

export const copyDir = (root: string, ledgerId: string) => join(root, ledgerId, GENERATION_DIR);

export type Copy =
  | { readonly state: 'missing'; readonly dest: Destination }
  | { readonly state: 'empty'; readonly dest: Destination }
  | { readonly state: 'invalid'; readonly dest: Destination; readonly problem: string }
  | { readonly state: 'ok'; readonly dest: Destination; readonly identity: Identity; readonly entries: readonly Entry[] };

/**
 * Reads one destination's copy. `missing`: the directory doesn't exist (a drive not connected, or deleted); `empty`:
 * it exists with no ledger in it (recreated). A copy holding more than one ledger, a broken identity, a torn or edited
 * line, or a chain that doesn't verify is `invalid`. Never repaired here.
 */
export function readCopy(dest: Destination, fs: LedgerFs = realFs): Copy {
  const names = fs.list(dest.path);
  if (names === null) return { state: 'missing', dest };
  const ledgers = names.filter((n) => n !== LOCK_DIR && !n.startsWith('.'));
  if (ledgers.length === 0) return { state: 'empty', dest };
  if (ledgers.length > 1) return { state: 'invalid', dest, problem: `more than one ledger in ${dest.path}: ${ledgers.join(', ')}` };
  const dir = copyDir(dest.path, ledgers[0] ?? '');
  const idBytes = fs.read(join(dir, IDENTITY_FILE));
  const text = fs.read(join(dir, LEDGER_FILE));
  if (!idBytes || !text) return { state: 'invalid', dest, problem: `${dir} is incomplete (no ${idBytes ? LEDGER_FILE : IDENTITY_FILE})` };
  let identity: Identity;
  try {
    identity = JSON.parse(idBytes.toString('utf8')) as Identity;
  } catch {
    return { state: 'invalid', dest, problem: `${join(dir, IDENTITY_FILE)} is not JSON` };
  }
  const parsed = parseLines(text.toString('utf8'));
  if ('problem' in parsed) return { state: 'invalid', dest, problem: `${dest.path}: ${parsed.problem}` };
  const broken = chainProblem(parsed.entries);
  if (broken) return { state: 'invalid', dest, problem: `${dest.path}: the chain does not verify: ${broken}` };
  const ledgerId = ledgerIdOf(parsed.entries);
  if (ledgerId !== identity.ledgerId || ledgers[0] !== ledgerId)
    return { state: 'invalid', dest, problem: `${dest.path}: its genesis, its identity and its directory name different ledgers` };
  if (identity.destinationId !== dest.id)
    return { state: 'invalid', dest, problem: `${dest.path}: it is destination ${identity.destinationId}, not ${dest.id} (swapped?)` };
  return { state: 'ok', dest, identity, entries: parsed.entries };
}

/** A copy's entries, or none when it isn't readable (for reports and tests). */
export const entriesOf = (c: Copy): readonly Entry[] => (c.state === 'ok' ? c.entries : []);

/**
 * Reads the copy at `path` as the destination it says it is (its identity file), for a source whose configuration
 * entry is not known yet (the primary's rebuild). The caller still checks that the ledger configures it.
 */
export function readCopyAt(path: string, fs: LedgerFs = realFs): Copy {
  const probe: Destination = { id: '', path };
  const names = fs.list(path);
  if (names === null) return { state: 'missing', dest: probe };
  const ledgers = names.filter((n) => n !== LOCK_DIR && !n.startsWith('.'));
  if (ledgers.length !== 1) return ledgers.length ? { state: 'invalid', dest: probe, problem: `more than one ledger in ${path}` } : { state: 'empty', dest: probe };
  const idBytes = fs.read(join(copyDir(path, ledgers[0] ?? ''), IDENTITY_FILE));
  try {
    const identity = JSON.parse(idBytes?.toString('utf8') ?? '') as Identity;
    return readCopy({ id: identity.destinationId, path }, fs);
  } catch {
    return { state: 'invalid', dest: probe, problem: `${path} has no readable identity` };
  }
}

/**
 * Appends entries to a copy that holds exactly `expectPrefix` now, then checks they are durable (A2-4): the copy is read
 * back whole, its chain verifies, and it is exactly the prefix plus the new lines, byte for byte. Returns a problem or
 * null. Never retries: a failed destination is reported, and the protocol decides (D7).
 */
export function appendToCopy(dest: Destination, ledgerId: string, expectPrefix: readonly Entry[], entries: readonly Entry[], fs: LedgerFs = realFs): string | null {
  const dir = copyDir(dest.path, ledgerId);
  const file = join(dir, LEDGER_FILE);
  const want = Buffer.from([...expectPrefix, ...entries].map(lineOf).join(''), 'utf8');
  try {
    const before = fs.read(file);
    const prefix = Buffer.from(expectPrefix.map(lineOf).join(''), 'utf8');
    if (!before || !before.equals(prefix)) return `${dest.path}: the copy changed underneath (it no longer holds what was read)`;
    fs.appendDurable(file, Buffer.from(entries.map(lineOf).join(''), 'utf8'));
  } catch (e) {
    return `${dest.path}: the write failed: ${(e as Error).message}`;
  }
  return readBackProblem(dest, ledgerId, want, fs);
}

/** Creates a destination's copy holding `entries` (init, add-destination, rebuild-destination), then verifies it. */
export function createCopy(dest: Destination, entries: readonly Entry[], fs: LedgerFs = realFs): string | null {
  const ledgerId = ledgerIdOf(entries);
  if (!ledgerId) return 'a copy starts with genesis';
  const dir = copyDir(dest.path, ledgerId);
  const want = Buffer.from(entries.map(lineOf).join(''), 'utf8');
  try {
    fs.mkdirp(dir);
    const identity: Identity = { ledgerId, destinationId: dest.id };
    fs.replaceDurable(join(dir, IDENTITY_FILE), Buffer.from(`${JSON.stringify(identity)}\n`, 'utf8'));
    fs.replaceDurable(join(dir, LEDGER_FILE), want);
  } catch (e) {
    return `${dest.path}: the write failed: ${(e as Error).message}`;
  }
  return readBackProblem(dest, ledgerId, want, fs);
}

function readBackProblem(dest: Destination, ledgerId: string, want: Buffer, fs: LedgerFs): string | null {
  const got = fs.read(join(copyDir(dest.path, ledgerId), LEDGER_FILE));
  if (!got || !got.equals(want)) return `${dest.path}: read back different bytes than were written: not durable`;
  const copy = readCopy(dest, fs);
  if (copy.state !== 'ok') return `${dest.path}: read back, it does not verify: ${copy.state === 'invalid' ? copy.problem : copy.state}`;
  return null;
}
