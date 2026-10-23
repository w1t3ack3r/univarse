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

/**
 * A destination's own record of what it is: the ledger it belongs to and its id in that ledger's configuration. From
 * generation 2 (A3's waiver) it also names the generation and the attempt, so a copy is never read as another's.
 */
export interface Identity {
  readonly ledgerId: string;
  readonly destinationId: string;
  readonly generation?: number;
  readonly attempt?: string;
}

export const LOCK_DIR = '.lock';
/** Generation 1's directory (A2). A waiver's generation N lives in `gen-NNNN/<attempt>/`: fresh per attempt (A3-2). */
export const GENERATION_DIR = 'gen-0001';
const LEDGER_FILE = 'ledger.jsonl';
const IDENTITY_FILE = 'destination.json';

/** Where a copy lives within a destination: generation 1 has no attempt; every later generation has one. */
export interface Location {
  readonly generation: number;
  readonly attempt: string | null;
}
export const GEN1: Location = { generation: 1, attempt: null };

export const generationDir = (generation: number) => `gen-${String(generation).padStart(4, '0')}`;
export const locationDir = (root: string, ledgerId: string, at: Location = GEN1) =>
  at.generation === 1 ? join(root, ledgerId, GENERATION_DIR) : join(root, ledgerId, generationDir(at.generation), at.attempt ?? '');
export const copyDir = locationDir;
/** A location's place under the ledger in the bucket: `gen-0001`, or `gen-NNNN/<attempt>` (A3). */
export const bucketDir = (at: Location = GEN1) => (at.generation === 1 ? GENERATION_DIR : `${generationDir(at.generation)}/${at.attempt ?? ''}`);

/** The location a chain belongs to, from its genesis (generation 1 when it names none). */
export function locationOf(entries: readonly Entry[]): Location {
  const g = entries[0];
  return g?.type === 'genesis' && g.generation > 1 ? { generation: g.generation, attempt: g.attempt ?? null } : GEN1;
}

export const sameLocation = (a: Location, b: Location) => a.generation === b.generation && a.attempt === b.attempt;

export type Copy =
  | { readonly state: 'missing'; readonly dest: Destination }
  | { readonly state: 'empty'; readonly dest: Destination }
  | { readonly state: 'invalid'; readonly dest: Destination; readonly problem: string }
  | { readonly state: 'ok'; readonly dest: Destination; readonly identity: Identity; readonly entries: readonly Entry[]; readonly at: Location };

type LedgerDir =
  | { readonly state: 'missing' }
  | { readonly state: 'empty' }
  | { readonly state: 'invalid'; readonly problem: string }
  | { readonly state: 'one'; readonly ledgerId: string };

/** The single ledger-id directory in a destination, or why there isn't exactly one. */
function ledgerDirOf(path: string, fs: LedgerFs): LedgerDir {
  const names = fs.list(path);
  if (names === null) return { state: 'missing' };
  const ledgers = names.filter((n) => n !== LOCK_DIR && !n.startsWith('.'));
  if (ledgers.length === 0) return { state: 'empty' };
  if (ledgers.length > 1) return { state: 'invalid', problem: `more than one ledger in ${path}: ${ledgers.join(', ')}` };
  return { state: 'one', ledgerId: ledgers[0] ?? '' };
}

/**
 * Every location a destination holds (generation 1, and each later generation's attempts), whatever their state. The
 * caller decides which is of record; an attempt never established stays here, inert, and is never read as part of
 * another (A3-3).
 */
export function listLocations(path: string, fs: LedgerFs = realFs): { ledgerId: string | null; locations: Location[] } {
  const d = ledgerDirOf(path, fs);
  if (d.state !== 'one') return { ledgerId: null, locations: [] };
  const locations: Location[] = [];
  for (const g of fs.list(join(path, d.ledgerId)) ?? []) {
    const m = /^gen-(\d{4})$/.exec(g);
    if (!m) continue;
    const generation = Number(m[1]);
    if (generation === 1) locations.push(GEN1);
    else for (const a of fs.list(join(path, d.ledgerId, g)) ?? []) if (!a.startsWith('.')) locations.push({ generation, attempt: a });
  }
  return { ledgerId: d.ledgerId, locations };
}

/**
 * Reads one destination's copy at a location (generation 1 by default). `missing`: the directory doesn't exist (a drive
 * not connected, deleted, or that attempt never written there); `empty`: it exists with no ledger in it (recreated). A
 * copy holding more than one ledger, a broken identity, an identity or genesis naming another location, a torn or
 * edited line, or a chain that doesn't verify is `invalid`. Never repaired here.
 */
export function readCopy(dest: Destination, fs: LedgerFs = realFs, at: Location = GEN1): Copy {
  const d = ledgerDirOf(dest.path, fs);
  if (d.state === 'missing' || d.state === 'empty') return { state: d.state, dest };
  if (d.state === 'invalid') return { state: 'invalid', dest, problem: d.problem };
  const dir = locationDir(dest.path, d.ledgerId, at);
  const idBytes = fs.read(join(dir, IDENTITY_FILE));
  const text = fs.read(join(dir, LEDGER_FILE));
  if (!idBytes && !text && at.generation > 1) return { state: 'missing', dest };
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
  if (ledgerId !== identity.ledgerId || d.ledgerId !== ledgerId)
    return { state: 'invalid', dest, problem: `${dest.path}: its genesis, its identity and its directory name different ledgers` };
  if (identity.destinationId !== dest.id)
    return { state: 'invalid', dest, problem: `${dest.path}: it is destination ${identity.destinationId}, not ${dest.id} (swapped?)` };
  const idAt: Location = { generation: identity.generation ?? 1, attempt: identity.attempt ?? null };
  if (!sameLocation(idAt, at) || !sameLocation(locationOf(parsed.entries), at))
    return { state: 'invalid', dest, problem: `${dir}: its identity or genesis names another generation or attempt (moved?)` };
  return { state: 'ok', dest, identity, entries: parsed.entries, at };
}

/** A copy's entries, or none when it isn't readable (for reports and tests). */
export const entriesOf = (c: Copy): readonly Entry[] => (c.state === 'ok' ? c.entries : []);

/**
 * Reads the copy at `path` (and location) as the destination it says it is (its identity file), for a source whose
 * configuration entry is not known yet (the primary's rebuild, the waiver). The caller still checks that the ledger
 * configures it.
 */
export function readCopyAt(path: string, fs: LedgerFs = realFs, at: Location = GEN1): Copy {
  const probe: Destination = { id: '', path };
  const d = ledgerDirOf(path, fs);
  if (d.state === 'missing' || d.state === 'empty') return { state: d.state, dest: probe };
  if (d.state === 'invalid') return { state: 'invalid', dest: probe, problem: d.problem };
  const idBytes = fs.read(join(locationDir(path, d.ledgerId, at), IDENTITY_FILE));
  try {
    const identity = JSON.parse(idBytes?.toString('utf8') ?? '') as Identity;
    return readCopy({ id: identity.destinationId, path }, fs, at);
  } catch {
    return { state: 'invalid', dest: probe, problem: `${path} has no readable identity` };
  }
}

/**
 * The longest prefix of a copy's chain that verifies, from whatever its file holds, for the waiver's best-effort union
 * (A3-4): a copy damaged at line N still says what lines 1..N-1 recorded. Nothing here is ever authoritative.
 */
export function salvage(path: string, fs: LedgerFs = realFs, at: Location = GEN1): { ledgerId: string; entries: Entry[] } | null {
  const d = ledgerDirOf(path, fs);
  if (d.state !== 'one') return null;
  const text = fs.read(join(locationDir(path, d.ledgerId, at), LEDGER_FILE))?.toString('utf8');
  if (!text) return null;
  const good: Entry[] = [];
  for (const line of text.split('\n')) {
    if (!line) break;
    const parsed = parseLines(`${line}\n`);
    if ('problem' in parsed) break;
    const next = [...good, ...parsed.entries];
    if (chainProblem(next)) break;
    good.push(...parsed.entries);
  }
  const ledgerId = ledgerIdOf(good);
  return ledgerId ? { ledgerId, entries: good } : null;
}

/**
 * Appends entries to a copy that holds exactly `expectPrefix` now (its location is its genesis's), then checks they are
 * durable (A2-4): the copy is read back whole, its chain verifies, and it is exactly the prefix plus the new lines,
 * byte for byte. Returns a problem or null. Never retries: a failed destination is reported, and the protocol decides.
 */
export function appendToCopy(dest: Destination, ledgerId: string, expectPrefix: readonly Entry[], entries: readonly Entry[], fs: LedgerFs = realFs): string | null {
  const at = locationOf(expectPrefix);
  const file = join(locationDir(dest.path, ledgerId, at), LEDGER_FILE);
  const want = Buffer.from([...expectPrefix, ...entries].map(lineOf).join(''), 'utf8');
  try {
    const before = fs.read(file);
    const prefix = Buffer.from(expectPrefix.map(lineOf).join(''), 'utf8');
    if (!before || !before.equals(prefix)) return `${dest.path}: the copy changed underneath (it no longer holds what was read)`;
    fs.appendDurable(file, Buffer.from(entries.map(lineOf).join(''), 'utf8'));
  } catch (e) {
    return `${dest.path}: the write failed: ${(e as Error).message}`;
  }
  return readBackProblem(dest, ledgerId, want, at, fs);
}

/**
 * Creates a destination's copy holding `entries` (init, add-destination, rebuild-destination, a waiver's candidate),
 * at its genesis's location, then verifies it. A waiver attempt's directory is always fresh: an existing one is refused.
 */
export function createCopy(dest: Destination, entries: readonly Entry[], fs: LedgerFs = realFs): string | null {
  const ledgerId = ledgerIdOf(entries);
  if (!ledgerId) return 'a copy starts with genesis';
  const at = locationOf(entries);
  const dir = locationDir(dest.path, ledgerId, at);
  const want = Buffer.from(entries.map(lineOf).join(''), 'utf8');
  try {
    if (at.generation > 1 && fs.list(dir) !== null) return `${dir} already exists: an attempt's directory is always fresh`;
    fs.mkdirp(dir);
    const identity: Identity = at.generation > 1 ? { ledgerId, destinationId: dest.id, generation: at.generation, attempt: at.attempt ?? '' } : { ledgerId, destinationId: dest.id };
    fs.replaceDurable(join(dir, IDENTITY_FILE), Buffer.from(`${JSON.stringify(identity)}\n`, 'utf8'));
    fs.replaceDurable(join(dir, LEDGER_FILE), want);
  } catch (e) {
    return `${dest.path}: the write failed: ${(e as Error).message}`;
  }
  return readBackProblem(dest, ledgerId, want, at, fs);
}

function readBackProblem(dest: Destination, ledgerId: string, want: Buffer, at: Location, fs: LedgerFs): string | null {
  const got = fs.read(join(locationDir(dest.path, ledgerId, at), LEDGER_FILE));
  if (!got || !got.equals(want)) return `${dest.path}: read back different bytes than were written: not durable`;
  const copy = readCopy(dest, fs, at);
  if (copy.state !== 'ok') return `${dest.path}: read back, it does not verify: ${copy.state === 'invalid' ? copy.problem : copy.state}`;
  return null;
}

const MARKER_FILE = 'current.json';

/**
 * A3: written beside a destination's generation directories once a later generation is established there (never for a
 * candidate), so that deleting that generation's directory can't make an older one look current: a destination whose
 * marker names a generation that can't be read fails closed.
 */
export function writeCurrentMarker(root: string, ledgerId: string, at: Location, fs: LedgerFs = realFs): string | null {
  try {
    fs.replaceDurable(join(root, ledgerId, MARKER_FILE), Buffer.from(`${JSON.stringify({ generation: at.generation, attempt: at.attempt })}\n`, 'utf8'));
    return null;
  } catch (e) {
    return `${root}: the generation marker could not be written: ${(e as Error).message}`;
  }
}

/** The generation a destination's marker names as current, or null (generation 1, or no marker). */
export function readCurrentMarker(root: string, fs: LedgerFs = realFs): { ledgerId: string; at: Location } | null {
  const d = ledgerDirOf(root, fs);
  if (d.state !== 'one') return null;
  const bytes = fs.read(join(root, d.ledgerId, MARKER_FILE));
  if (!bytes) return null;
  try {
    const m = JSON.parse(bytes.toString('utf8')) as { generation?: unknown; attempt?: unknown };
    if (typeof m.generation !== 'number' || typeof m.attempt !== 'string') return null;
    return { ledgerId: d.ledgerId, at: { generation: m.generation, attempt: m.attempt } };
  } catch {
    return null;
  }
}

/** The newest established generation's location a destination holds (A3), or generation 1. */
export function latestEstablished(path: string, fs: LedgerFs = realFs): Location {
  let best: Location = GEN1;
  for (const at of listLocations(path, fs).locations) {
    if (at.generation <= best.generation) continue;
    const c = readCopyAt(path, fs, at);
    if (c.state === 'ok' && c.entries.some((e) => e.type === 'established')) best = at;
  }
  return best;
}
