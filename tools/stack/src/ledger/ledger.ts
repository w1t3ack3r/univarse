// Spec 0020 D7, D8 (step 1), BK16: the authoritative ledger. Only the configured destinations' own copies can be
// authoritative, and only when every one of them is readable, verifies, belongs to this ledger and agrees with the
// others: equal, or one ahead by the single operation being written when a crash came (A2-5). A backup set's copy or
// the bucket's is never read here. Writes go to every configured destination, durable on each before the next step.
import { canonical, destinationsOf, ledgerIdOf, nextEntry, opOf, type Destination, type Entry, type EntryBody } from './chain.js';
import { appendToCopy, readCopy, realFs, type Copy, type LedgerFs } from './store.js';

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
  | { readonly ok: true; readonly ledgerId: string; readonly entries: readonly Entry[]; readonly destinations: readonly Destination[]; readonly copies: readonly Extract<Copy, { state: 'ok' }>[] }
  | { readonly ok: false; readonly problems: readonly string[] };

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

const GUIDANCE = [
  'reconnect the destination, then run the command again;',
  'or, with another configured destination readable: `pnpm stack:keys ledger rebuild-destination <path>` (a lost or emptied one), `pnpm stack:keys ledger remove-destination <path>` (one gone for good).',
].join(' ');

/**
 * D8 step 1. `primary` is where the ledger starts; its latest configuration names the others. A configuration entry
 * still being written can name a destination the primary doesn't know yet, so the set is re-read from the copy that
 * is furthest ahead until it stops changing.
 */
export function establishAuthority(primary: Destination, fs: LedgerFs = realFs, opts: { exclude?: string } = {}): Authority {
  const p = readCopy(primary, fs);
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
    for (const d of config) if (!read.has(d.id)) read.set(d.id, samePath(d.path, primary.path) ? { ...p, dest: d } : readCopy(d, fs));
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
  return { ok: true, ledgerId, entries: longest.entries, destinations: config, copies };
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
