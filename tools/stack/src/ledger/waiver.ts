// Spec 0020 D8 (the waiver), BK17, A3: `pnpm stack:keys ledger waive`, for the emergency in which no configured
// destination of the generation of record can be read and the owner chooses to run the stack anyway. It never claims
// what it can't establish:
//   • it records that completeness could not be established and the no-resurrection guarantee is waived for every
//     destruction before this moment (a chained transition record, and a platform audit event);
//   • it re-applies every destruction found in ANY copy (the old generations' remains, `--from` copies, the bucket) and
//     every key_destruction row, as a best effort, not a proof;
//   • it starts a new generation, fully guaranteed from then on. Its bootstrap (A3-3):
//       W1  a candidate genesis, in a fresh directory per attempt, on every named destination;
//       W2  `established` with the plan, on every one; only then is the generation authoritative (else: inert);
//       W3  the audit event, keyed by the attempt (written once);
//       W4  the re-applications, each idempotent by its op, each recorded; done only when every one is.
// Recovery resumes W3 and W4 after a crash (completeWaiver); W1 and W2 are never resumed: a retry is a new attempt.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  chainProblem,
  destinationsOf,
  ledgerIdOf,
  nextEntry,
  opStates,
  planOf,
  planStates,
  WAIVER_STATEMENT,
  type Destination,
  type Entry,
  type PlanItem,
  type Transition,
} from './chain.js';
import { classifyAttempts, Ledger, LedgerWriteError, noCrash, type Attempt } from './ledger.js';
import type { ProtocolDeps, Result } from './protocol.js';
import { appendToCopy, createCopy, listLocations, readCopy, readCopyAt, readCurrentMarker, realFs, salvage, writeCurrentMarker, type LedgerFs, type Location } from './store.js';

/** The phrase `ledger waive` requires, word for word (D8). */
export const WAIVER_CONFIRMATION = 'destroyed tenants may return';

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const newId = () => `dest-${randomUUID().slice(0, 8)}`;

interface Chain {
  readonly source: string;
  readonly generation: number;
  readonly entries: readonly Entry[];
}

const key = (generation: number, attempt: string | null | undefined) => `${String(generation)}/${attempt ?? ''}`;
const chainKey = (c: Chain) => {
  const g = c.entries[0];
  return key(c.generation, g?.type === 'genesis' ? g.attempt : null);
};

/** Every path any readable copy names, from the primary and the owner's `--from` paths, to the fixed point. */
function discoverPaths(start: readonly string[], fs: LedgerFs): string[] {
  const paths = new Set(start.map((p) => resolve(p)));
  for (let round = 0; round < 6; round++) {
    let grew = false;
    for (const path of [...paths]) {
      for (const at of listLocations(path, fs).locations) {
        const s = salvage(path, fs, at);
        if (!s) continue;
        for (const d of [...destinationsOf(s.entries), ...(s.entries[0]?.type === 'genesis' ? s.entries[0].destinations : [])])
          if (![...paths].some((p) => samePath(p, d.path))) {
            paths.add(resolve(d.path));
            grew = true;
          }
      }
    }
    if (!grew) break;
  }
  return [...paths];
}

/** Rebuilds the bucket's chains (one object per entry) from their links: each genesis, extended while `prev` matches. */
export function bucketChains(lines: readonly string[]): Chain[] {
  const entries: Entry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // an object that isn't an entry is evidence of nothing
    }
  }
  const byPrev = new Map<string, Entry[]>();
  for (const e of entries) byPrev.set(e.prev, [...(byPrev.get(e.prev) ?? []), e]);
  const out: Chain[] = [];
  for (const g of entries.filter((e) => e.type === 'genesis' && e.seq === 1)) {
    const chain: Entry[] = [g];
    for (;;) {
      const last = chain[chain.length - 1];
      const next = (byPrev.get(last?.hash ?? '') ?? []).find((e) => e.seq === (last?.seq ?? 0) + 1 && !chainProblem([...chain, e]));
      if (!next) break;
      chain.push(next);
    }
    if (!chainProblem(chain)) out.push({ source: 'the bucket', generation: g.type === 'genesis' ? g.generation : 1, entries: chain });
  }
  return out;
}

/**
 * A3-4: the plan, from the union of every chain read and the database's rows. An accepted destruction (a `committed`
 * record, a re-applied planned op, or a row) is re-applied; a pending one never accepted, re-run with its
 * preconditions; an aborted one, nothing. Two sources that disagree on an op's tenant or kind stop the waiver.
 */
export function buildPlan(
  chains: readonly Chain[],
  rows: readonly { op: string; tenantId: string; kind: 'TENANT' | 'RETIRED'; versions: readonly number[] }[],
): { ok: true; plan: PlanItem[] } | { ok: false; problems: string[] } {
  const items = new Map<string, PlanItem>();
  const aborted = new Set<string>();
  const problems: string[] = [];
  const put = (item: PlanItem) => {
    const prior = items.get(item.op);
    if (!prior) return void items.set(item.op, item);
    if (prior.tenant.id !== item.tenant.id || prior.kind !== item.kind) {
      problems.push(`op ${item.op}: ${prior.source} and ${item.source} disagree on its tenant or kind`);
      return;
    }
    // Accepted anywhere beats pending; the versions are the union (re-destroying more is the safe side).
    const mode = prior.mode === 'reapply' || item.mode === 'reapply' ? 'reapply' : 'rollforward';
    const versions = [...new Set([...prior.versions, ...item.versions])].sort((a, b) => a - b);
    items.set(item.op, { ...prior, mode, versions, source: prior.mode === 'reapply' ? prior.source : item.source });
  };
  for (const c of chains) {
    const { ops } = opStates(c.entries);
    for (const s of ops.values()) {
      const base = { op: s.pending.op, tenant: s.pending.tenant, kind: s.pending.kind };
      if (s.outcome?.type === 'aborted') aborted.add(s.pending.op);
      else if (s.outcome?.type === 'committed') put({ ...base, versions: s.outcome.versions, mode: 'reapply', source: c.source });
      else put({ ...base, versions: s.pending.versions, mode: 'rollforward', source: c.source });
    }
    for (const p of planStates(c.entries).plan.values()) {
      if (p.result?.type === 'reapplied' || p.item.mode === 'reapply') put({ ...p.item, mode: 'reapply', source: c.source });
      else if (p.result?.type !== 'not_applied') put({ ...p.item, source: c.source });
    }
  }
  for (const r of rows) put({ op: r.op, tenant: { id: r.tenantId, slug: items.get(r.op)?.tenant.slug ?? r.tenantId }, kind: r.kind, versions: r.versions, mode: 'reapply', source: 'the database' });
  if (problems.length) return { ok: false, problems };
  // A database row makes an op accepted whatever a copy says; an op aborted everywhere and with no row is left alone.
  const rowOps = new Set(rows.map((r) => r.op));
  const plan = [...items.values()].filter((i) => !(aborted.has(i.op) && !rowOps.has(i.op) && i.mode === 'rollforward'));
  return { ok: true, plan: plan.sort((a, b) => a.op.localeCompare(b.op)) };
}

/** `pnpm stack:keys ledger waive --reason … --confirm "…" --destination <path>… [--from <path>]…` */
export async function waive(deps: ProtocolDeps, opts: { reason: string; confirm: string; destinations: readonly string[]; from: readonly string[] }): Promise<Result> {
  const fs = deps.fs ?? realFs;
  const crash = deps.crash ?? noCrash;
  if (opts.confirm !== WAIVER_CONFIRMATION) return { ok: false, lines: [`the waiver needs its exact confirmation: --confirm "${WAIVER_CONFIRMATION}"`] };
  if (opts.reason.trim().length < 8) return { ok: false, lines: ['a reason is required (--reason "…")'] };
  if (!opts.destinations.length) return { ok: false, lines: ['name the new generation\'s destinations (--destination <path>, at least the primary)'] };
  if (!opts.destinations.some((p) => samePath(p, deps.primary.path))) return { ok: false, lines: [`the primary (${deps.primary.path}) must be one of the new generation's destinations`] };
  const lock = await deps.lock('ledger waive');
  try {
    // Only when no configured destination of the current generation can be read: otherwise the guarantee-preserving
    // commands keep the guarantee (BK16), and the waiver is refused.
    // The bucket names destinations too: with the primary lost, it is how the others are found.
    const bucket = await deps.db.readBucket();
    const fromBucket = bucket.ok ? bucketChains(bucket.lines) : [];
    const named = fromBucket.flatMap((c) => [...destinationsOf(c.entries), ...(c.entries[0]?.type === 'genesis' ? c.entries[0].destinations : [])]).map((d) => d.path);
    const paths = discoverPaths([deps.primary.path, ...opts.from, ...opts.destinations, ...named], fs);
    // A3-3: an inert attempt (W1 or W2 stopped) was never authority; it is neither the current generation nor evidence.
    const { attempts } = classifyAttempts(paths, fs);
    const inert = new Set(attempts.filter((a) => a.status === 'inert').map((a) => key(a.at.generation, a.at.attempt)));
    const own = ownCopiesOfRecord(paths, attempts, fs);
    if (own.length)
      return {
        ok: false,
        lines: [
          `a configured destination of the current generation is readable (${own.join(', ')}): no waiver. Keep the guarantee with \`pnpm stack:keys ledger rebuild-destination\` or \`remove-destination\`, or reconnect the others.`,
        ],
      };

    // Every copy readable at all, damaged ones as far as they verify (best effort, never authoritative).
    const chains: Chain[] = [];
    for (const path of paths)
      for (const at of listLocations(path, fs).locations) {
        const s = salvage(path, fs, at);
        if (s && !inert.has(key(at.generation, at.attempt))) chains.push({ source: `${path} (generation ${String(at.generation)}${at.attempt ? `, attempt ${at.attempt}` : ''})`, generation: at.generation, entries: s.entries });
      }
    const lines: string[] = [];
    const idsOf = (cs: readonly Chain[]) => [...new Set(cs.map((c) => ledgerIdOf(c.entries)).filter((x): x is string => !!x))];
    // The copies on disk name the ledger. The bucket keeps every ledger it was ever sent (for 10 years): only that
    // ledger's chains in it count; with no copy on disk, it must name one ledger.
    const local = idsOf(chains);
    if (local.length > 1) return { ok: false, lines: [`the copies belong to more than one ledger (${local.join(', ')}): nothing waived; investigate before choosing`] };
    if (bucket.ok) {
      const ours = fromBucket.filter((c) => !inert.has(chainKey(c)) && (!local[0] || ledgerIdOf(c.entries) === local[0]));
      const others = idsOf(fromBucket).filter((id) => id !== local[0]);
      if (local[0] && others.length) lines.push(`the bucket also holds other ledgers (${others.join(', ')}): not this one, not in the plan`);
      chains.push(...ours);
    } else lines.push(`the bucket could not be read (${bucket.problem}): its entries are not in the plan`);

    const ids = idsOf(chains);
    if (ids.length > 1) return { ok: false, lines: [`no copy on disk, and the bucket holds more than one ledger (${ids.join(', ')}): nothing waived; name a copy with --from, or investigate`] };
    const ledgerId = ids[0] ?? randomUUID();
    const ev = await deps.db.evidence([...new Set(chains.flatMap((c) => [...opStates(c.entries).ops.values()].map((s) => s.pending.tenant.id)))]);
    const built = buildPlan(chains, ev.rows);
    if (!built.ok) return { ok: false, lines: ['the copies read disagree: nothing waived', ...built.problems] };

    const generation = Math.max(1, ...chains.map((c) => c.generation)) + 1;
    const attempt = randomUUID();
    const destinations: Destination[] = opts.destinations.map((p) => (samePath(p, deps.primary.path) ? { id: deps.primary.id, path: deps.primary.path } : { id: newId(), path: resolve(p) }));
    const transition: Transition = {
      reason: opts.reason.trim(),
      at: new Date().toISOString(),
      oldHeads: chains.map((c) => ({ source: c.source, generation: c.generation, seq: c.entries.at(-1)?.seq ?? 0, hash: c.entries.at(-1)?.hash ?? '' })),
      statement: WAIVER_STATEMENT,
    };
    const genesis = nextEntry(null, { type: 'genesis', ledgerId, generation, attempt, destinations, transition });

    // W1: the candidate, on every named destination. A failure leaves an inert attempt: nothing authoritative, the
    // database untouched, the deploy still blocked.
    for (const d of destinations) {
      const problem = createCopy(d, [genesis], fs);
      if (problem) return { ok: false, lines: [...lines, `the waiver failed (W1, the candidate): ${problem}. No generation exists, nothing in the database changed, and recovery stays blocked. Run it again once every destination can be written (a new attempt).`] };
      crash(`waive:candidate:${d.id}`);
    }
    // W2: `established`, with the plan, on every one. Only then is the generation authoritative.
    const established = nextEntry(genesis, { type: 'established', attempt, plan: built.plan });
    for (const d of destinations) {
      const problem = appendToCopy(d, ledgerId, [genesis], [established], fs);
      if (problem) return { ok: false, lines: [...lines, `the waiver failed (W2, establishing): ${problem}. This attempt is inert: never authoritative, never completed. Run it again (a new attempt).`] };
      crash(`waive:established:${d.id}`);
    }
    const at: Location = { generation, attempt };
    for (const d of destinations) {
      const problem = writeCurrentMarker(d.path, ledgerId, at, fs);
      if (problem) lines.push(`warning: ${problem} (the generation is established; only the marker that detects its deletion is missing there)`);
    }
    lines.push(`generation ${String(generation)} established on ${destinations.map((d) => d.path).join(', ')}, with ${String(built.plan.length)} destruction(s) to re-apply`);
    const done = await completeWaiver(deps, lines);
    return { ok: done.ok, lines: [...done.lines, ...(done.ok ? [`no-resurrection guarantee waived since ${transition.at}. ${WAIVER_STATEMENT}`] : [])] };
  } finally {
    lock.release();
  }
}

/**
 * Destinations of the current generation whose own copy reads: the highest generation with an attempt that isn't inert
 * (or a marker), else generation 1.
 */
function ownCopiesOfRecord(paths: readonly string[], attempts: readonly Attempt[], fs: LedgerFs): string[] {
  const live = attempts.filter((a) => a.status !== 'inert');
  const marked = Math.max(1, ...paths.map((p) => readCurrentMarker(p, fs)?.at.generation ?? 1));
  const top = Math.max(marked, ...live.map((a) => a.at.generation));
  const out: string[] = [];
  if (top === 1) {
    for (const p of paths) if (listLocations(p, fs).locations.some((at) => at.generation === 1 && readCopyAt(p, fs, at).state === 'ok')) out.push(p);
    return out;
  }
  for (const a of live.filter((x) => x.at.generation === top))
    for (const d of a.genesis.destinations) if (!a.unreadable.some((u) => u.id === d.id) && readCopy(d, fs, a.at).state === 'ok') out.push(d.path);
  return out;
}

/**
 * W3 and W4, from the generation of record (the waiver's own run, or recovery after a crash in it). The audit event
 * is written once (keyed by the attempt in the database, and recorded as `audited` here). Each planned op without a
 * result is applied, idempotent by its op, then recorded; a refused roll-forward is recorded as not applied. Done only
 * when every planned op has a result. Conflicting evidence stops it.
 */
export async function completeWaiver(deps: ProtocolDeps, lines: string[] = [], given?: Ledger): Promise<Result> {
  const crash = deps.crash ?? noCrash;
  let ledger = given;
  if (!ledger) {
    const opened = Ledger.open(deps.primary, { ...(deps.fs ? { fs: deps.fs } : {}), crash });
    if ('problems' in opened) return { ok: false, lines: [...lines, 'STOP: the new generation is not authoritative', ...opened.problems] };
    ledger = opened.ledger;
  }
  const genesis = ledger.entries[0];
  if (genesis?.type !== 'genesis' || genesis.generation < 2 || !genesis.attempt) return { ok: true, lines };
  const attempt = genesis.attempt;
  try {
    if (!ledger.entries.some((e) => e.type === 'audited')) {
      const plan = planOf(ledger.entries);
      const a = await deps.db.waiverAudit(attempt, {
        ledgerId: ledger.ledgerId,
        generation: genesis.generation,
        reason: genesis.transition?.reason ?? '',
        statement: WAIVER_STATEMENT,
        copiesRead: (genesis.transition?.oldHeads ?? []).map((h) => h.source),
        planned: plan.length,
      });
      crash('waive:audit');
      ledger.append({ type: 'audited', attempt, auditSeq: a.auditSeq }, 'audited');
      lines.push(`the waiver is recorded in the platform audit (seq ${a.auditSeq})`);
    }
    const { plan, problems } = planStates(ledger.entries);
    if (problems.length) return { ok: false, lines: [...lines, 'STOP: the plan\'s records are inconsistent', ...problems] };
    for (const s of plan.values()) {
      if (s.result) continue;
      const i = s.item;
      if (i.mode === 'reapply') {
        const r = await deps.db.reapply(i.op, i.tenant.id, i.kind, i.versions);
        crash(`waive:applied:${i.op}`);
        if (r.outcome !== 'reapplied') return { ok: false, lines: [...lines, `STOP: planned op ${i.op} (${i.tenant.slug}) could not be re-applied (${r.outcome === 'refused' ? r.why : r.detail}): conflicting evidence, or the database is unavailable`] };
        ledger.append({ type: 'reapplied', op: i.op, destroyedNow: r.destroyed, recorded: r.recorded, activeDestroyed: r.activeDestroyed }, `reapplied:${i.op}`);
        lines.push(`planned op ${i.op} (${i.tenant.slug}): re-applied, versions ${r.destroyed.join(',') || 'none'} destroyed now`);
      } else {
        const out = await deps.db.destroy(i.op, i.tenant.slug, i.kind === 'RETIRED' ? i.versions[0] : undefined);
        crash(`waive:applied:${i.op}`);
        if (out.outcome === 'unknown') return { ok: false, lines: [...lines, `STOP: planned op ${i.op}: the outcome is unknown (${out.detail}); run recovery again`] };
        if (out.outcome === 'refused') {
          ledger.append({ type: 'not_applied', op: i.op, reason: out.why }, `not_applied:${i.op}`);
          lines.push(`planned op ${i.op} (${i.tenant.slug}): a pending destruction never accepted, refused now (${out.why}); nothing destroyed`);
        } else {
          ledger.append({ type: 'reapplied', op: i.op, destroyedNow: out.versions, recorded: true, activeDestroyed: false }, `reapplied:${i.op}`);
          lines.push(`planned op ${i.op} (${i.tenant.slug}): rolled forward and destroyed`);
        }
      }
    }
    return { ok: true, lines };
  } catch (e) {
    if (e instanceof LedgerWriteError) return { ok: false, lines: [...lines, `STOP: a waiver record is not durable everywhere: ${e.problem}`] };
    throw e;
  }
}

/** For reports: the waiver statement of the generation of record, or null in generation 1. */
export function waivedSince(entries: readonly Entry[]): string | null {
  const g = entries[0];
  return g?.type === 'genesis' && g.generation > 1 && g.transition ? `no-resurrection guarantee waived since ${g.transition.at} (generation ${String(g.generation)})` : null;
}

