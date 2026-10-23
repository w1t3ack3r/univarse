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

/**
 * The owner's review of A2: what genesis says about destructions made before the ledger existed. They are adopted from
 * the database's own evidence at that moment, each with its own op; the statement says what that can't establish.
 */
export interface History {
  readonly capturedAt: string;
  readonly statement: string;
  readonly adopted: readonly { readonly op: string; readonly tenant: { readonly id: string; readonly slug: string }; readonly kind: DestructionKind; readonly versions: readonly number[]; readonly auditSeqs: readonly string[] }[];
}

export const HISTORY_STATEMENT =
  "Destructions made before this ledger existed are recorded from this database's own evidence at this time. Any that a restore had already undone before then cannot be known, and are not represented.";

/**
 * A3 (D8's waiver): what a new generation's genesis records about the one before it. It never claims the old history
 * is complete: only what any copy showed of it, and that its completeness could not be established.
 */
export interface Transition {
  readonly reason: string;
  readonly at: string;
  /** The old generations' last heads as each copy read showed them (none, when no copy could be read). */
  readonly oldHeads: readonly { readonly source: string; readonly generation: number; readonly seq: number; readonly hash: string }[];
  readonly statement: string;
}

export const WAIVER_STATEMENT = "The previous generation's completeness could not be established. The no-resurrection guarantee is waived for every destruction before this generation.";

/** A3-4/A3-7: one destruction the waiver re-applies, from the union of every copy read and the database's rows. */
export interface PlanItem {
  readonly op: string;
  readonly tenant: { readonly id: string; readonly slug: string };
  readonly kind: DestructionKind;
  readonly versions: readonly number[];
  /** `reapply`: an accepted destruction (a committed record, or a database row). `rollforward`: a pending one never accepted, re-run with its preconditions. */
  readonly mode: 'reapply' | 'rollforward';
  readonly source: string;
}

/** The owner's review of A2: what an abandoned op's record says. Never that nothing was destroyed. */
export const ABANDON_STATEMENT =
  'The outcome of this destruction was not established: it may have committed before an older database was restored. If it did, its keys may be usable again. The no-resurrection guarantee does not cover it.';

export type EntryBody =
  | {
      readonly type: 'genesis';
      readonly ledgerId: string;
      readonly generation: number;
      readonly destinations: readonly Destination[];
      readonly history?: History;
      /** From generation 2 (A3): the waiver attempt this candidate belongs to, and what it records of the generation before. */
      readonly attempt?: string;
      readonly transition?: Transition;
    }
  /** A3-3 (W2): the generation is authoritative once this is durable on every one of its destinations; it carries the plan. */
  | { readonly type: 'established'; readonly attempt: string; readonly plan: readonly PlanItem[] }
  /** A3-6 (W3): the waiver's platform audit event is written (once, keyed by the attempt). */
  | { readonly type: 'audited'; readonly attempt: string; readonly auditSeq: string }
  /** A3-7: a planned roll-forward the database refused (its preconditions no longer hold). Nothing was destroyed for it. */
  | { readonly type: 'not_applied'; readonly op: string; readonly reason: string }
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
      /** A destruction from before the ledger, adopted at init: its keys were already destroyed (History). */
      readonly adoption?: true;
    }
  | {
      readonly type: 'committed';
      readonly op: string;
      readonly versions: readonly number[];
      readonly destroyedAt: string;
      /** The destruction's platform audit event (its chain position): a checkpoint of the platform chain (D12). */
      readonly auditSeq: string;
      /** `destroy` when the command saw its transaction commit; `recovery` when the database's evidence showed it (D8). */
      readonly by: 'destroy' | 'recovery' | 'adoption';
    }
  | { readonly type: 'aborted'; readonly op: string; readonly reason: string }
  /** The owner's explicit waiver for one pending op whose outcome can't be established (ABANDON_STATEMENT). */
  | { readonly type: 'abandoned'; readonly op: string; readonly reason: string; readonly statement: string }
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
  /** Set while the outcome is unknown and waived; a later `committed` (the row found after all) supersedes it. */
  readonly abandoned: Extract<Entry, { type: 'abandoned' }> | null;
  readonly reapplied: readonly Extract<Entry, { type: 'reapplied' }>[];
}

/** A3: the plan a generation's `established` record carries (empty in generation 1). */
export function planOf(entries: readonly Entry[]): readonly PlanItem[] {
  for (const e of entries) if (e.type === 'established') return e.plan;
  return [];
}

export interface PlanState {
  readonly item: PlanItem;
  /** Its result in this generation: re-applied (in force), or not applied (refused), or none yet (W4 outstanding). */
  readonly result: Extract<Entry, { type: 'reapplied' | 'not_applied' }> | null;
}

/** A3-7: each planned op's result. A planned op recorded twice is a problem. */
export function planStates(entries: readonly Entry[]): { plan: Map<string, PlanState>; problems: string[] } {
  const plan = new Map<string, { item: PlanItem; result: PlanState['result'] }>(planOf(entries).map((item) => [item.op, { item, result: null }]));
  const problems: string[] = [];
  for (const e of entries) {
    if (e.type !== 'reapplied' && e.type !== 'not_applied') continue;
    const s = plan.get(e.op);
    if (!s) continue; // a re-application of this generation's own committed op (opStates)
    if (s.result && (e.type === 'not_applied' || s.result.type === 'not_applied')) problems.push(`planned op ${e.op}: a second result (seq ${String(e.seq)})`);
    else if (!s.result) s.result = e;
  }
  return { plan, problems };
}

/** Every op's records, in ledger order. A record without its `pending`, or a second outcome, is a problem. */
export function opStates(entries: readonly Entry[]): { ops: Map<string, OpState>; problems: string[] } {
  const planned = new Set(planOf(entries).map((i) => i.op));
  const ops = new Map<string, { pending: OpState['pending']; outcome: OpState['outcome']; abandoned: OpState['abandoned']; reapplied: OpState['reapplied'][number][] }>();
  const problems: string[] = [];
  for (const e of entries) {
    if (e.type === 'pending') {
      if (ops.has(e.op)) problems.push(`op ${e.op}: a second pending record (seq ${String(e.seq)})`);
      else ops.set(e.op, { pending: e, outcome: null, abandoned: null, reapplied: [] });
      continue;
    }
    if (e.type !== 'committed' && e.type !== 'aborted' && e.type !== 'reapplied' && e.type !== 'abandoned') continue;
    if (e.type === 'reapplied' && planned.has(e.op) && !ops.has(e.op)) continue; // a planned op's result (planStates)
    const s = ops.get(e.op);
    if (!s) problems.push(`op ${e.op}: a ${e.type} record with no pending record (seq ${String(e.seq)})`);
    else if (e.type === 'abandoned') {
      if (s.outcome || s.abandoned) problems.push(`op ${e.op}: abandoned after an outcome (seq ${String(e.seq)})`);
      else s.abandoned = e;
    } else if (e.type === 'aborted' && s.abandoned) problems.push(`op ${e.op}: aborted after being abandoned (seq ${String(e.seq)})`);
    else if (e.type === 'reapplied') {
      if (s.outcome?.type !== 'committed') problems.push(`op ${e.op}: reapplied without being committed (seq ${String(e.seq)})`);
      else s.reapplied.push(e);
    } else if (s.outcome) problems.push(`op ${e.op}: a second outcome (seq ${String(e.seq)})`);
    else s.outcome = e;
  }
  return { ops, problems };
}
