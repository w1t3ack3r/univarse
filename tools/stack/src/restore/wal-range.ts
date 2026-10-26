// Spec 0020 B2-7: the WAL a restore target needs. Every segment from the set's start file through the target's, on the
// set's timeline, plus the timeline's history file when it isn't the first. A segment missing before one that was
// shipped is a gap, which waiting can't fill; segments missing only at the end may still be on their way (PostgreSQL
// closes a quiet segment within archive_timeout, B-2), so the rehearsal ships and waits for them.
const SEGMENT_NAME = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/;
/** 16 MB segments, as the stack runs: 256 per 4 GB "xlogid" (pgbase.ts PER_ID). */
const PER_ID = 0x100;

/** The segment after `name`, on the same timeline. */
export function nextSegment(name: string): string {
  const m = SEGMENT_NAME.exec(name);
  if (!m) throw new Error(`not a WAL segment: ${name}`);
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');
  const id = parseInt(m[2] ?? '', 16);
  const seg = parseInt(m[3] ?? '', 16);
  if (seg >= PER_ID) throw new Error(`not a 16 MB segment: ${name}`);
  return seg + 1 === PER_ID ? `${m[1] ?? ''}${hex(id + 1)}${hex(0)}` : `${m[1] ?? ''}${m[2] ?? ''}${hex(seg + 1)}`;
}

/** Every segment from `from` through `to` inclusive, on one timeline. */
export function segmentsBetween(from: string, to: string): string[] {
  if (from.slice(0, 8) !== to.slice(0, 8)) throw new Error(`${from} and ${to} are on different timelines`);
  if (to < from) throw new Error(`the target segment ${to} is before the set's start ${from}`);
  const out = [from];
  while (out.at(-1) !== to) {
    out.push(nextSegment(out.at(-1) ?? from));
    if (out.length > 1_000_000) throw new Error('the WAL range is implausibly long');
  }
  return out;
}

export type WalNeed =
  /** Everything is shipped: these are the files, in order (history first). */
  | { readonly state: 'complete'; readonly files: readonly string[] }
  /** Only the newest segments are missing: ship and wait for them. */
  | { readonly state: 'waiting'; readonly missing: readonly string[]; readonly newestShipped: string | null }
  /** A segment is missing before one that was shipped: nothing will fill it. */
  | { readonly state: 'gap'; readonly missing: string }
  /** The timeline's history file isn't shipped. */
  | { readonly state: 'no-history'; readonly missing: string };

/**
 * What a restore from a set needs, given the shipped files on its timeline (bare names, `.gz.seal` removed).
 * `target`: the target's segment (the facts' position), or `newest` for a time target, whose segment can't be known
 * before recovery runs: then every segment from the start through the newest shipped one is needed, without a gap.
 */
export function walNeed(startWal: string, timeline: number, target: string | 'newest', shipped: readonly string[]): WalNeed {
  const tl = timeline.toString(16).toUpperCase().padStart(8, '0');
  if (startWal.slice(0, 8) !== tl) throw new Error(`the set's start ${startWal} is not on its timeline ${String(timeline)}`);
  const have = new Set(shipped);
  const files: string[] = [];
  if (timeline > 1) {
    const history = `${tl}.history`;
    if (!have.has(history)) return { state: 'no-history', missing: history };
    files.push(history);
  }
  const onTimeline = shipped.filter((n) => SEGMENT_NAME.test(n) && n.startsWith(tl) && n >= startWal).sort();
  const newestShipped = onTimeline.at(-1) ?? null;
  const end = target === 'newest' ? newestShipped ?? startWal : target;
  const needed = segmentsBetween(startWal, end);
  const missing = needed.filter((s) => !have.has(s));
  if (!missing.length) return { state: 'complete', files: [...files, ...needed] };
  // A missing segment with a shipped one after it is a gap; only a missing tail can still arrive.
  const firstMissing = missing[0] ?? '';
  if (newestShipped !== null && newestShipped > firstMissing) return { state: 'gap', missing: firstMissing };
  return { state: 'waiting', missing, newestShipped };
}
