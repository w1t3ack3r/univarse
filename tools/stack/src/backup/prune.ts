// Spec 0020 D6, BK8, B-13: retention, decided by a pure function and applied at the end of every backup, under the
// registry lock. Kept: the 7 newest complete sets (the dailies), and the newest complete set of each of the 4 newest
// ISO weeks (UTC) older than every daily's week (the weeklies), which gives D6's "about 35 days" boundary. Never
// deleted: the newest complete set, or WAL a kept set needs (every segment from the oldest kept set's start WAL file on). Deleted too: incomplete sets (no index) more than a day old. WAL is never deleted while no
// complete set exists.
import { join } from 'node:path';
import { listSets, realSetFs, SETS, WAL, type SetFs, type SetOnDisk } from './set.js';

export const DAILY = 7;
export const WEEKLY = 4;
const DAY = 24 * 3600 * 1000;

/** The ISO 8601 week of a UTC date, as `YYYY-Www`. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // the Thursday of this week decides its year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${String(t.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

/** A WAL file name's segment number (its last 16 hex digits), comparable across timelines. */
const segno = (name: string) => BigInt(`0x${name.slice(8, 24)}`);
const WAL_SEGMENT = /^([0-9A-F]{24})\.gz\.seal$/;

export interface PrunePlan {
  readonly keep: readonly string[];
  readonly deleteSets: readonly string[];
  /** Null: delete no WAL. Otherwise every segment numbered below this one's goes. */
  readonly walFrom: string | null;
}

export function planPrune(sets: readonly SetOnDisk[], now: Date): PrunePlan {
  const complete = sets.filter((s) => s.index).sort((a, b) => b.setId.localeCompare(a.setId));
  const dailies = complete.slice(0, DAILY);
  const keep = new Set(dailies.map((s) => s.setId));
  const dailyWeeks = new Set(dailies.map((s) => isoWeek(s.createdAt)));
  const weeks: string[] = [];
  for (const s of complete) {
    const w = isoWeek(s.createdAt);
    if (dailyWeeks.has(w) || weeks.includes(w)) continue;
    if (weeks.length === WEEKLY) break;
    weeks.push(w);
    keep.add(s.setId); // the newest set of that week (complete is newest first)
  }
  const deleteSets = sets
    .filter((s) => (s.index ? !keep.has(s.setId) : now.getTime() - s.createdAt.getTime() > DAY))
    .map((s) => s.setId);
  const kept = complete.filter((s) => keep.has(s.setId));
  const oldest = kept[kept.length - 1];
  return { keep: [...keep].sort(), deleteSets: deleteSets.sort(), walFrom: oldest?.index ? oldest.index.startWal : null };
}

/** WAL segment files to delete under `wal/<timeline>/`: those numbered below `walFrom`. History files are kept. */
export function walToDelete(files: readonly { readonly timeline: string; readonly name: string }[], walFrom: string | null): string[] {
  if (!walFrom) return [];
  const from = segno(walFrom);
  return files.filter((f) => WAL_SEGMENT.test(f.name) && segno(f.name) < from).map((f) => join(f.timeline, f.name));
}

/** Applies the plan. Returns one line per deletion, by set id or WAL file (no content, no secret). */
export function prune(destination: string, now: Date, fs: SetFs = realSetFs): string[] {
  const plan = planPrune(listSets(destination, fs), now);
  const lines: string[] = [];
  for (const id of plan.deleteSets) {
    fs.remove(join(destination, SETS, id));
    lines.push(`pruned set ${id}`);
  }
  const files = fs.list(join(destination, WAL)).flatMap((timeline) => fs.list(join(destination, WAL, timeline)).map((name) => ({ timeline, name })));
  const wal = walToDelete(files, plan.walFrom);
  for (const f of wal) fs.remove(join(destination, WAL, f));
  if (wal.length) lines.push(`pruned ${String(wal.length)} WAL segments older than ${plan.walFrom ?? ''}`);
  return lines;
}
