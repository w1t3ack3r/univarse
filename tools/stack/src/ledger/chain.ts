// Spec 0020 D7: the durable ledger's entries. Hash-chained JSON lines, never key material. Every destination holds the
// same bytes for the same entries (canonical JSON), so copies compare entry by entry (A2-2, A2-5).
import { createHash } from 'node:crypto';

export const LEDGER_FORMAT = 1;
export const GENESIS_PREV = '0'.repeat(64);

/** A configured destination: its id (named in its own copy's identity file) and where it lives on the host. */
export interface Destination {
  readonly id: string;
  readonly path: string;
}

export type DestructionKind = 'TENANT' | 'RETIRED';

export type EntryBody =
  | { readonly type: 'genesis'; readonly ledgerId: string; readonly generation: number; readonly destinations: readonly Destination[] }
  | {
      readonly type: 'config';
      readonly change: 'add' | 'remove' | 'rebuild';
      readonly destination: Destination;
      /** The full set after the change: the latest config entry is the ledger's configuration. */
      readonly destinations: readonly Destination[];
      readonly reason?: string;
    }
  | {
      readonly type: 'pending';
      readonly op: string;
      readonly tenant: { readonly id: string; readonly slug: string };
      readonly kind: DestructionKind;
      readonly versions: readonly number[];
      readonly requestedAt: string;
      /** What the read-only check saw (D7): statuses and times only. */
      readonly preconditions: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'committed';
      readonly op: string;
      readonly versions: readonly number[];
      readonly destroyedAt: string;
      /** The destruction's platform audit event (its chain position): a checkpoint of the platform chain (D12). */
      readonly auditSeq: string;
      /** `destroy` when the command saw its transaction commit; `recovery` when the database's evidence showed it (D8). */
      readonly by: 'destroy' | 'recovery';
    }
  | { readonly type: 'aborted'; readonly op: string; readonly reason: string }
  | {
      readonly type: 'reapplied';
      readonly op: string;
      readonly destroyedNow: readonly number[];
      readonly recorded: boolean;
      readonly activeDestroyed: boolean;
    };

export type Entry = EntryBody & { readonly v: number; readonly seq: number; readonly at: string; readonly prev: string; readonly hash: string };

/** JSON with object keys sorted at every level: the same entry is always the same bytes. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashOf(entry: Omit<Entry, 'hash'>): string {
  return createHash('sha256').update(canonical(entry)).digest('hex');
}

/** The next entry after `prev` (null for the first). */
export function nextEntry(prev: Entry | null, body: EntryBody, at: string = new Date().toISOString()): Entry {
  const unsigned = { ...body, v: LEDGER_FORMAT, seq: (prev?.seq ?? 0) + 1, at, prev: prev?.hash ?? GENESIS_PREV };
  return { ...unsigned, hash: hashOf(unsigned) };
}

export const lineOf = (e: Entry): string => `${canonical(e)}\n`;

/** Parses a copy's text. Any line that isn't a JSON object is a problem (never skipped). */
export function parseLines(text: string): { entries: Entry[] } | { problem: string } {
  if (text === '') return { entries: [] };
  if (!text.endsWith('\n')) return { problem: 'the last line is incomplete (a torn write)' };
  const entries: Entry[] = [];
  const lines = text.slice(0, -1).split('\n');
  for (const [i, line] of lines.entries()) {
    try {
      const e = JSON.parse(line) as Entry;
      if (typeof e !== 'object' || Array.isArray(e)) return { problem: `line ${String(i + 1)} is not an entry` };
      if (lineOf(e) !== `${line}\n`) return { problem: `line ${String(i + 1)} is not in canonical form (edited?)` };
      entries.push(e);
    } catch {
      return { problem: `line ${String(i + 1)} is not JSON` };
    }
  }
  return { entries };
}

/** The chain's own check: one genesis first, consecutive seqs, each `prev` the previous hash, each hash its content. */
export function chainProblem(entries: readonly Entry[]): string | null {
  for (const [i, e] of entries.entries()) {
    const { hash, ...unsigned } = e;
    if (e.v !== LEDGER_FORMAT) return `entry ${String(i + 1)}: unknown format ${String(e.v)}`;
    if (e.seq !== i + 1) return `entry ${String(i + 1)}: seq ${String(e.seq)} out of order`;
    if (e.prev !== (i === 0 ? GENESIS_PREV : entries[i - 1]?.hash)) return `entry ${String(e.seq)}: prev does not match the previous entry`;
    if (hashOf(unsigned) !== hash) return `entry ${String(e.seq)}: hash does not match its content`;
    if ((i === 0) !== (e.type === 'genesis')) return `entry ${String(e.seq)}: ${i === 0 ? 'the first entry is not genesis' : 'a second genesis'}`;
  }
  return null;
}

/** The configuration in force at the end of the chain: the latest genesis or config entry's destinations. */
export function destinationsOf(entries: readonly Entry[]): readonly Destination[] {
  for (const e of [...entries].reverse()) if (e.type === 'genesis' || e.type === 'config') return e.destinations;
  return [];
}

export const ledgerIdOf = (entries: readonly Entry[]): string | null => (entries[0]?.type === 'genesis' ? entries[0].ledgerId : null);

/** The op an entry belongs to, if any. */
export const opOf = (e: Entry): string | null => ('op' in e ? e.op : null);

export interface OpState {
  readonly pending: Extract<Entry, { type: 'pending' }>;
  readonly outcome: Extract<Entry, { type: 'committed' | 'aborted' }> | null;
  readonly reapplied: readonly Extract<Entry, { type: 'reapplied' }>[];
}

/** Every op's records, in ledger order. A record without its `pending`, or a second outcome, is a problem. */
export function opStates(entries: readonly Entry[]): { ops: Map<string, OpState>; problems: string[] } {
  const ops = new Map<string, { pending: OpState['pending']; outcome: OpState['outcome']; reapplied: OpState['reapplied'][number][] }>();
  const problems: string[] = [];
  for (const e of entries) {
    if (e.type === 'pending') {
      if (ops.has(e.op)) problems.push(`op ${e.op}: a second pending record (seq ${String(e.seq)})`);
      else ops.set(e.op, { pending: e, outcome: null, reapplied: [] });
      continue;
    }
    if (e.type !== 'committed' && e.type !== 'aborted' && e.type !== 'reapplied') continue;
    const s = ops.get(e.op);
    if (!s) problems.push(`op ${e.op}: a ${e.type} record with no pending record (seq ${String(e.seq)})`);
    else if (e.type === 'reapplied') {
      if (s.outcome?.type !== 'committed') problems.push(`op ${e.op}: reapplied without being committed (seq ${String(e.seq)})`);
      else s.reapplied.push(e);
    } else if (s.outcome) problems.push(`op ${e.op}: a second outcome (seq ${String(e.seq)})`);
    else s.outcome = e;
  }
  return { ops, problems };
}
