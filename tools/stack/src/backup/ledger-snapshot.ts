// Spec 0020 D14, B-8: the durable ledger's copy in a backup set. The caller holds the ledger lock (after the registry
// lock), so no destruction or recovery writes while it is read. Authority is established first, read-only, exactly as
// recovery does: a set is never taken from a ledger that can't be established. The copy is the longest agreeing
// destination's files, in a destination's own layout (<ledgerId>/gen-…/ledger.jsonl, destination.json, markers), so a
// restore can hand it to `ledger waive --from` as evidence. A set's copy is a snapshot, never authoritative (D8).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lineOf, type Destination, type Entry } from '../ledger/chain.js';
import { establishAuthority } from '../ledger/ledger.js';
import { LOCK_DIR, locationDir } from '../ledger/store.js';
import type { TarEntry } from './tar.js';

export interface LedgerSnapshot {
  readonly ledgerId: string;
  readonly generation: number;
  readonly attempt: string | null;
  /** The snapshot's last entry: a prefix of the live ledger ends here. */
  readonly seq: number;
  readonly hash: string;
  readonly destinations: number;
}

/** Every regular file under `dir`, skipping the lock and dot-files (the bucket copy's own progress record). */
export function readTree(root: string, dir: string): TarEntry[] {
  const out: TarEntry[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === LOCK_DIR || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...readTree(root, p));
    else if (e.isFile()) out.push({ name: relative(root, p).split('\\').join('/'), data: readFileSync(p) });
  }
  return out;
}

export function snapshotLedger(
  primary: Destination,
  /** Reads a copy's files; a test changes what it returns, as a writer ignoring the lock would. */
  read: (root: string, dir: string) => TarEntry[] = readTree,
): { ok: true; snapshot: LedgerSnapshot; entries: TarEntry[] } | { ok: false; problems: readonly string[] } {
  const a = establishAuthority(primary);
  if (!a.ok) return { ok: false, problems: ["the shred ledger's authority can't be established, so no set is taken (spec 0020 D8):", ...a.problems] };
  const longest = a.copies.reduce((x, c) => (c.entries.length > x.entries.length ? c : x));
  const last: Entry | undefined = longest.entries.at(-1);
  if (!last) return { ok: false, problems: ['the ledger is empty'] };
  const tar = read(longest.dest.path, join(longest.dest.path, a.ledgerId));
  // The file copied is the one authority verified: it ends with the chain's last entry, byte for byte.
  const own = relative(longest.dest.path, join(locationDir(longest.dest.path, a.ledgerId, a.at), 'ledger.jsonl')).split('\\').join('/');
  if (!tar.find((t) => t.name === own)?.data.toString('utf8').endsWith(lineOf(last)))
    return { ok: false, problems: ['the ledger changed while it was copied (it is read under the ledger lock): not taken'] };
  return {
    ok: true,
    entries: tar,
    snapshot: { ledgerId: a.ledgerId, generation: a.at.generation, attempt: a.at.attempt, seq: last.seq, hash: last.hash, destinations: a.destinations.length },
  };
}
