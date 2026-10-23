// Spec 0020 D7, D8 (step 1), BK16: the authoritative ledger. Only the configured destinations' own copies can be
// authoritative, and only when every one of them is readable, verifies, belongs to this ledger and agrees with the
// others: equal, or one ahead by the single operation being written when a crash came (A2-5). A backup set's copy or
// the bucket's is never read here. Writes go to every configured destination, durable on each before the next step.
import { canonical, destinationsOf, ledgerIdOf, nextEntry, opOf, type Destination, type Entry, type EntryBody } from './chain.js';
import { appendToCopy, GEN1, listLocations, readCopy, readCopyAt, readCurrentMarker, realFs, sameLocation, type Copy, type LedgerFs, type Location } from './store.js';

/** Stops a test (or a crash) at a named point: `<step>:<destination id>` after each destination write (D13). */
export type Crash = (point: string) => void;
export const noCrash: Crash = () => undefined;

export class LedgerWriteError extends Error {
  constructor(
    readonly entry: Entry,
    /** The destinations that hold the entry durably. */
    readonly written: readonly string[],
    readonly problem: string,
  ) {
    super(`ledger entry ${String(entry.seq)} (${entry.type}) is not durable everywhere: ${problem}`);
    this.name = 'LedgerWriteError';
  }
}

export type Authority =
  | {
      readonly ok: true;
      readonly ledgerId: string;
      /** The generation of record (A3): generation 1, or a waiver's established attempt. */
      readonly at: Location;
      readonly entries: readonly Entry[];
      readonly destinations: readonly Destination[];
      readonly copies: readonly Extract<Copy, { state: 'ok' }>[];
    }
  | { readonly ok: false; readonly problems: readonly string[] };

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

const GUIDANCE = [
  'reconnect the destination, then run the command again;',
  'or, with another configured destination readable: `pnpm stack:keys ledger rebuild-destination <path>` (a lost or emptied one), `pnpm stack:keys ledger remove-destination <path>` (one gone for good).',
].join(' ');

export type Genesis = Extract<Entry, { type: 'genesis' }>;

/**
 * A3-3: one waiver attempt and what its destinations show:
 * - `established`: `established` is on every destination of it still configured, each readable;
 * - `undetermined`: `established` is on some, and every readable one of them has it, but some can't be read (it may be
 *   established there too, or not): never inert, never authority, so it fails closed;
 * - `inert`: no readable destination shows `established`, or a readable one lacks it (W1 or W2 stopped). Never read.
 */
export interface Attempt {
  readonly at: Location;
  readonly genesis: Genesis;
  readonly status: 'established' | 'undetermined' | 'inert';
  readonly unreadable: readonly Destination[];
  /** The longest verifying copy of it (for the waiver's union, when not inert). */
  readonly entries: readonly Entry[];
}

/**
 * Every later-generation attempt reachable from `start` (and every destination any copy found names, to the fixed
 * point), classified, with every generation marker found.
 */
export function classifyAttempts(start: readonly string[], fs: LedgerFs = realFs): { attempts: Attempt[]; markers: { path: string; at: Location }[]; paths: string[] } {
  const paths = new Set<string>(start);
  const found = new Map<string, { at: Location; genesis: Genesis }>();
  const markers: { path: string; at: Location }[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const path of [...paths]) {
      if (seen.has(path)) continue;
      seen.add(path);
      const marker = readCurrentMarker(path, fs);
      if (marker) markers.push({ path, at: marker.at });
      for (const at of listLocations(path, fs).locations) {
        const c = readCopyAt(path, fs, at);
        if (c.state !== 'ok' || c.entries[0]?.type !== 'genesis') continue;
        const g = c.entries[0];
        if (at.generation > 1) found.set(`${String(at.generation)}/${at.attempt ?? ''}`, { at, genesis: g });
        for (const d of [...g.destinations, ...destinationsOf(c.entries)])
          if (![...paths].some((p) => samePath(p, d.path))) {
            paths.add(d.path);
            grew = true;
          }
      }
    }
    if (!grew) break;
  }
  const attempts: Attempt[] = [];
  for (const { at, genesis } of found.values()) {
    const copies = genesis.destinations.map((d) => ({ d, c: readCopy(d, fs, at) }));
    const ok = copies.filter((x): x is { d: Destination; c: Extract<Copy, { state: 'ok' }> } => x.c.state === 'ok');
    const longest = ok.reduce<Extract<Copy, { state: 'ok' }> | null>((a, x) => (!a || x.c.entries.length > a.entries.length ? x.c : a), null);
    const has = (c: Extract<Copy, { state: 'ok' }>) => c.entries.some((e) => e.type === 'established');
    // The destinations still configured in this attempt (a later config entry may have removed one).
    const configured = new Set(destinationsOf(longest?.entries ?? [genesis as Entry]).map((d) => d.id));
    const required = copies.filter((x) => configured.has(x.d.id));
    const unreadable = required.filter((x) => x.c.state !== 'ok').map((x) => x.d);
    let status: Attempt['status'];
    if (!ok.some((x) => has(x.c)) || required.some((x) => x.c.state === 'ok' && !has(x.c))) status = 'inert';
    else status = unreadable.length ? 'undetermined' : 'established';
    attempts.push({ at, genesis, status, unreadable, entries: longest?.entries ?? [genesis] });
  }
  return { attempts: attempts.sort((a, b) => b.at.generation - a.at.generation), markers, paths: [...paths] };
}

/**
 * A3 (D8's waiver): which generation is of record. A later generation counts only through an attempt whose
 * `established` record is on every destination its genesis names that is still configured (A3-3). Then it is the
 * ONLY authority (A3-8): a destination of it that can't be read fails closed; the older generations are never read
 * as authority again. An inert attempt is never read. A destination whose marker names a generation that can't be
 * found fails closed too.
 */
export function generationOfRecord(primary: Destination, fs: LedgerFs = realFs): { ok: true; at: Location } | { ok: false; problems: string[] } {
  const { attempts, markers } = classifyAttempts([primary.path], fs);
  let record: Location | null = null;
  for (const a of attempts) {
    if (record && record.generation > a.at.generation) break;
    if (a.status === 'inert') continue;
    if (a.status === 'undetermined')
      return {
        ok: false,
        problems: [
          `generation ${String(a.at.generation)} is established, and it is the only authority (the older generations are never read as one again), but these of its destinations can't be read: ${a.unreadable.map((d) => `${d.id} (${d.path})`).join(', ')}`,
          GUIDANCE,
        ],
      };
    if (record && record.generation === a.at.generation)
      return { ok: false, problems: [`two attempts are established for generation ${String(a.at.generation)} (${record.attempt ?? ''}, ${a.at.attempt ?? ''}): this can't happen under the ledger lock; nothing is decided`] };
    record = a.at;
  }
  for (const m of markers)
    if (!record || m.at.generation > record.generation || (m.at.generation === record.generation && !sameLocation(m.at, record)))
      return {
        ok: false,
        problems: [`${m.path} records generation ${String(m.at.generation)} (attempt ${m.at.attempt ?? ''}) as current, but no established copy of it can be read: its directory is missing or damaged`, GUIDANCE],
      };
  return { ok: true, at: record ?? GEN1 };
}

/**
 * D8 step 1. `primary` is where the ledger starts; its latest configuration names the others. A configuration entry
 * still being written can name a destination the primary doesn't know yet, so the set is re-read from the copy that
 * is furthest ahead until it stops changing. All of it at the generation of record (A3).
 */
export function establishAuthority(primary: Destination, fs: LedgerFs = realFs, opts: { exclude?: string } = {}): Authority {
  const record = generationOfRecord(primary, fs);
  if (!record.ok) return { ok: false, problems: record.problems };
  const at = record.at;
  const p = readCopy(primary, fs, at);
  if (p.state === 'missing' || p.state === 'empty')
    return {
      ok: false,
      problems: [
        `the ledger's primary copy (${primary.path}) is ${p.state}. If another configured destination still holds the ledger: \`pnpm stack:keys ledger rebuild-destination ${primary.path} --from <its path>\`. Only if this stack has never had a ledger: \`pnpm stack:deploy <record> --init-ledger\` (the first deploy with it), or \`pnpm stack:keys ledger init\` once that image is deployed. A backup set's copy or the bucket's can never stand in for it.`,
      ],
    };
  if (p.state === 'invalid') return { ok: false, problems: [`the primary copy is not usable: ${p.problem}`] };
  const ledgerId = p.identity.ledgerId;

  // `exclude`: a destination being removed is judged as if already gone (the rest must stand on their own).
  const configured = (entries: readonly Entry[]) => destinationsOf(entries).filter((d) => d.id !== opts.exclude);
  let config = configured(p.entries);
  const read = new Map<string, Copy>();
  for (let round = 0; round < 4; round++) {
    for (const d of config) if (!read.has(d.id)) read.set(d.id, samePath(d.path, primary.path) ? { ...p, dest: d } : readCopy(d, fs, at));
    const longest = [...read.values()]
      .filter((c): c is Extract<Copy, { state: 'ok' }> => c.state === 'ok' && c.identity.ledgerId === ledgerId)
      .reduce((a, c) => (c.entries.length > a.entries.length ? c : a), p);
    const next = configured(longest.entries);
    if (canonical(next) === canonical(config)) break;
    config = next;
  }

  const problems: string[] = [];
  if (!config.some((d) => d.id === p.identity.destinationId && samePath(d.path, primary.path)))
    problems.push(`the primary (${primary.path}) is not in the ledger's configuration`);
  const copies: Extract<Copy, { state: 'ok' }>[] = [];
  for (const d of config) {
    const c = read.get(d.id) ?? ({ state: 'missing', dest: d } as const);
    if (c.state === 'ok' && c.identity.ledgerId !== ledgerId) problems.push(`${d.path} holds another ledger (${c.identity.ledgerId}): its genesis doesn't match`);
    else if (c.state === 'ok') copies.push(c);
    else if (c.state === 'invalid') problems.push(c.problem);
    else problems.push(`configured destination ${d.id} (${d.path}) is ${c.state === 'missing' ? 'unreadable or missing' : 'empty (recreated)'}`);
  }
  if (problems.length) return { ok: false, problems: [...problems, GUIDANCE] };

  const agreement = agree(copies);
  if (agreement) return { ok: false, problems: [agreement, GUIDANCE] };
  const longest = copies.reduce((a, c) => (c.entries.length > a.entries.length ? c : a));
  if (ledgerIdOf(longest.entries) !== ledgerId) return { ok: false, problems: ['the copies disagree on the ledger id'] };
  return { ok: true, ledgerId, at, entries: longest.entries, destinations: config, copies };
}

/** A2-5: null when the copies agree (equal, or a prefix of the longest short only by one operation), else why not. */
export function agree(copies: readonly { readonly dest: Destination; readonly entries: readonly Entry[] }[]): string | null {
  const longest = copies.reduce((a, c) => (c.entries.length > a.entries.length ? c : a));
  for (const c of copies) {
    for (const [i, e] of c.entries.entries()) {
      if (e.hash !== longest.entries[i]?.hash)
        return `the copies diverge at seq ${String(i + 1)}: ${c.dest.path} and ${longest.dest.path} hold different entries (neither is a prefix of the other)`;
    }
  }
  const shortest = Math.min(...copies.map((c) => c.entries.length));
  const suffix = longest.entries.slice(shortest);
  if (suffix.length === 0) return null;
  // What a crash can leave: one record mid-write (any record is written to every destination before the next one
  // starts), or a `pending` that couldn't reach a destination followed by its `aborted` where it did (D7). Never a
  // `pending` and its `committed`: `committed` is written only once `pending` is durable everywhere.
  const [first, second] = suffix;
  const oneRecord = suffix.length === 1;
  const stopped = suffix.length === 2 && first?.type === 'pending' && second?.type === 'aborted' && opOf(first) === opOf(second);
  if (oneRecord || stopped) return null;
  const behind = copies.filter((c) => c.entries.length === shortest).map((c) => c.dest.path);
  return `${behind.join(', ')} ${behind.length === 1 ? 'is' : 'are'} out of step: behind by ${String(suffix.length)} entries, more than the one operation a crash can leave in flight (an older copy swapped in?)`;
}

/** An authoritative ledger, open for writing. Hold the ledger lock (D14) for as long as one is open. */
export class Ledger {
  private constructor(
    readonly ledgerId: string,
    private all: Entry[],
    private copies: Map<string, { dest: Destination; entries: readonly Entry[] }>,
    private readonly fs: LedgerFs,
    private readonly crash: Crash,
  ) {}

  static open(primary: Destination, opts: { fs?: LedgerFs; crash?: Crash; exclude?: string } = {}): { ledger: Ledger } | { problems: readonly string[] } {
    const a = establishAuthority(primary, opts.fs, opts.exclude ? { exclude: opts.exclude } : {});
    if (!a.ok) return { problems: a.problems };
    const copies = new Map(a.copies.map((c) => [c.dest.id, { dest: c.dest, entries: c.entries }]));
    return { ledger: new Ledger(a.ledgerId, [...a.entries], copies, opts.fs ?? realFs, opts.crash ?? noCrash) };
  }

  get entries(): readonly Entry[] {
    return this.all;
  }

  get destinations(): readonly Destination[] {
    return destinationsOf(this.all);
  }

  /** D8: brings every copy that is behind level with the authoritative one (from its verified entries). */
  level(): string[] {
    const problems: string[] = [];
    for (const c of this.copies.values()) {
      if (c.entries.length === this.all.length) continue;
      const missing = this.all.slice(c.entries.length);
      const problem = appendToCopy(c.dest, this.ledgerId, c.entries, missing, this.fs);
      if (problem) problems.push(problem);
      else c.entries = this.all;
    }
    return problems;
  }

  /**
   * Appends one entry to every configured destination, in configuration order, and returns it once it is durable on
   * all of them. A destination that fails throws LedgerWriteError, naming those that hold it; nothing is retried.
   * `step` names the crash points (`<step>:<destination id>`, after each destination).
   */
  append(body: EntryBody, step: string = body.type): Entry {
    const entry = nextEntry(this.all.at(-1) ?? null, body);
    // A config change is written to the new set: an added destination's copy was created (adopted) beforehand; a
    // removed one is no longer written.
    const targets = body.type === 'config' ? body.destinations : this.destinations;
    const written: string[] = [];
    for (const d of targets) {
      const c = this.copies.get(d.id);
      const problem = c ? appendToCopy(d, this.ledgerId, c.entries, [entry], this.fs) : `no open copy for destination ${d.id}`;
      if (problem || !c) {
        if (written.length) this.all = [...this.all, entry]; // durable somewhere: the authoritative chain now holds it
        throw new LedgerWriteError(entry, written, problem ?? 'no open copy');
      }
      c.entries = [...c.entries, entry];
      written.push(d.id);
      this.crash(`${step}:${d.id}`);
    }
    this.all = [...this.all, entry];
    return entry;
  }

  /** Adds an open copy (a destination just created with this chain, before its config entry is appended). */
  adopt(dest: Destination, entries: readonly Entry[]): void {
    this.copies.set(dest.id, { dest, entries });
  }

  /** Forgets a copy (a destination being removed: it is no longer written). */
  drop(id: string): void {
    this.copies.delete(id);
  }
}
