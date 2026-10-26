// Spec 0020 B-11, B2-10: a rehearsal's recovery runs on a scratch copy of the ledger, never the real one. Recovery finds
// every destination by the path the ledger itself records, so a plain copy would lead it back to the real files.
// Instead, under the ledger lock, each configured destination's copy is verified (authority, read-only) and copied
// into `<scratch>/<destination id>/`; recovery then runs with a LedgerFs that maps each real destination's path to
// its copy. Any write that maps to no scratch copy is refused, so a path left unmapped can never reach a real
// destination: it fails the rehearsal instead.
import { join, posix, win32 } from 'node:path';
import { readTree } from '../backup/ledger-snapshot.js';
import type { Destination } from '../ledger/chain.js';
import { establishAuthority } from '../ledger/ledger.js';
import { realFs, type LedgerFs } from '../ledger/store.js';

export interface PathMap {
  readonly from: string;
  readonly to: string;
}

/** `p` mapped through the first root it is (or is under), compared as `canonical()` compares on Windows; or null. */
export function mapPath(p: string, map: readonly PathMap[], platform: NodeJS.Platform = process.platform): string | null {
  // The platform's own path rules, not the host's: a Windows path is resolved as Windows resolves it, wherever this runs.
  const path = platform === 'win32' ? win32 : posix;
  const norm = (x: string) => {
    const r = path.resolve(x);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const target = norm(p);
  for (const m of map) {
    const root = norm(m.from);
    if (target === root) return m.to;
    if (target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return path.join(m.to, path.relative(root, target));
  }
  return null;
}

export class ScratchWriteRefused extends Error {}

/** A LedgerFs over `base` in which each real destination's path reads and writes its scratch copy. */
export function remappedFs(map: readonly PathMap[], base: LedgerFs = realFs, platform: NodeJS.Platform = process.platform): LedgerFs {
  const read = (p: string) => mapPath(p, map, platform) ?? p;
  const write = (p: string) => {
    const to = mapPath(p, map, platform);
    if (to === null) throw new ScratchWriteRefused(`a rehearsal may write only its scratch ledger, not ${p}`);
    return to;
  };
  return {
    read: (p) => base.read(read(p)),
    list: (p) => base.list(read(p)),
    mkdirp: (p) => base.mkdirp(write(p)),
    appendDurable: (p, d) => base.appendDurable(write(p), d),
    replaceDurable: (p, d) => base.replaceDurable(write(p), d),
    remove: (p) => base.remove(write(p)),
    rename: (a, b) => base.rename(write(a), write(b)),
  };
}

/** One destination's verified state: what B2-6 step 12 compares before and after. */
export interface Head {
  readonly id: string;
  readonly seq: number;
  readonly hash: string;
}

/** The real ledger's heads (read-only): its id, generation and every configured destination's last entry. */
export function realHeads(primary: Destination, fs: LedgerFs = realFs): { ok: true; key: string; heads: readonly Head[] } | { ok: false; problems: readonly string[] } {
  const a = establishAuthority(primary, fs);
  if (!a.ok) return { ok: false, problems: a.problems };
  const heads = a.copies.map((c) => ({ id: c.dest.id, seq: c.entries.at(-1)?.seq ?? 0, hash: c.entries.at(-1)?.hash ?? '' })).sort((x, y) => x.id.localeCompare(y.id));
  return { ok: true, heads, key: JSON.stringify([a.ledgerId, a.at.generation, a.at.attempt, heads]) };
}

/**
 * Copies every configured destination's verified copy into `<scratch>/<destination id>/`. The caller holds the ledger
 * lock, briefly: authority is established first (read-only), and nothing is copied unless it is. Returns the map.
 */
export function copyToScratch(
  primary: Destination,
  scratch: string,
  fs: LedgerFs = realFs,
  write: (path: string, data: Buffer) => void = (path, data) => {
    fs.mkdirp(join(path, '..'));
    fs.replaceDurable(path, data);
  },
): { ok: true; map: readonly PathMap[] } | { ok: false; problems: readonly string[] } {
  const a = establishAuthority(primary, fs);
  if (!a.ok) return { ok: false, problems: ["the shred ledger's authority can't be established, so it can't be copied for the rehearsal (spec 0020 D8):", ...a.problems] };
  const map: PathMap[] = [];
  for (const d of a.destinations) {
    if (!/^[A-Za-z0-9_-]+$/.test(d.id)) return { ok: false, problems: [`a destination id the scratch copy can't use as a folder: ${d.id}`] };
    const to = join(scratch, d.id);
    for (const e of readTree(d.path, d.path)) write(join(to, ...e.name.split('/')), e.data);
    map.push({ from: d.path, to });
  }
  return { ok: true, map };
}
