// Spec 0020 D7, D8, D13, D14: the destruction protocol and its recovery, on the host. The database step runs in the
// `keys` job (KeysDb); everything else is the ledger, outside the stack. Every side effect is a dependency and every
// step a crash point, so the tests stop it anywhere (BK11).
//   destroy: lock → an authoritative ledger with nothing unresolved → the read-only check → `pending` durable on every
//            destination → the transaction (by op) → `committed` durable everywhere → only then success. A definite
//            refusal writes `aborted`; an unknown outcome leaves `pending` for recovery (A2-8).
//   recover: lock → an authoritative ledger, levelled → the database's evidence → each op made to hold, or a stop.
import { randomUUID } from 'node:crypto';
import { opStates, type Destination, type DestructionKind, type Entry, type OpState } from './chain.js';
import { Ledger, LedgerWriteError, noCrash, type Crash } from './ledger.js';
import type { LedgerFs } from './store.js';

export interface KeyState {
  readonly version: number;
  readonly status: string;
  readonly wrapErased: boolean;
}

export interface EvidenceRow {
  readonly op: string;
  readonly tenantId: string;
  readonly kind: DestructionKind;
  readonly versions: readonly number[];
  readonly destroyedAt: string;
  readonly auditSeq: string;
  readonly audit: { readonly action: string; readonly tenantId: string | null; readonly op: unknown; readonly versions: unknown } | null;
}

export interface Evidence {
  readonly rows: readonly EvidenceRow[];
  readonly tenants: Readonly<Record<string, readonly KeyState[]>>;
}

export type CheckResult =
  | { readonly eligible: true; readonly tenantId: string; readonly kind: DestructionKind; readonly versions: readonly number[]; readonly preconditions: Readonly<Record<string, unknown>> }
  | { readonly eligible: false; readonly why: string };

export type DestroyOutcome =
  | { readonly outcome: 'committed'; readonly tenantId: string; readonly kind: DestructionKind; readonly versions: readonly number[]; readonly destroyedAt: string; readonly auditSeq: string; readonly forget: readonly string[] }
  | { readonly outcome: 'refused'; readonly why: string }
  | { readonly outcome: 'unknown'; readonly detail: string };

export type ReapplyOutcome =
  | { readonly outcome: 'reapplied'; readonly destroyed: readonly number[]; readonly recorded: boolean; readonly activeDestroyed: boolean; readonly forget: readonly string[] }
  | { readonly outcome: 'refused'; readonly why: string }
  | { readonly outcome: 'unknown'; readonly detail: string };

/** The database step, as the `keys` job runs it from the deployed API image (A2-6). */
export interface KeysDb {
  check(slug: string, version?: number): Promise<CheckResult>;
  destroy(op: string, slug: string, version?: number): Promise<DestroyOutcome>;
  evidence(tenantIds: readonly string[]): Promise<Evidence>;
  reapply(op: string, tenantId: string, kind: DestructionKind, versions: readonly number[]): Promise<ReapplyOutcome>;
  /** The platform audit event for a ledger command (BK16). Throws on failure. */
  audit(action: string, detail: Readonly<Record<string, unknown>>): Promise<void>;
  /** The bucket copy (evidence only): returns a problem, never throws. */
  copyToBucket(ledgerId: string, entries: readonly Entry[]): Promise<string | null>;
}

export interface ProtocolDeps {
  readonly primary: Destination;
  readonly db: KeysDb;
  lock(holder: string): Promise<{ release(): void }>;
  log(line: string): void;
  readonly fs?: LedgerFs;
  readonly crash?: Crash;
  /** The bucket copy's own record of what it has copied (seq), kept beside the primary; best effort. */
  readonly bucket?: { copied(ledgerId: string): number; mark(ledgerId: string, seq: number): void };
}

export interface Result {
  readonly ok: boolean;
  readonly op?: string;
  readonly lines: readonly string[];
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
const unresolved = (ops: Map<string, OpState>) => [...ops.values()].filter((s) => !s.outcome).map((s) => s.pending.op);

function openLedger(deps: ProtocolDeps): { ledger: Ledger } | { problems: readonly string[] } {
  return Ledger.open(deps.primary, { ...(deps.fs ? { fs: deps.fs } : {}), crash: deps.crash ?? noCrash });
}

/** Best effort (D7: never relied on): copies to the bucket what it hasn't copied yet, and reports a failure. */
async function copyBacklog(deps: ProtocolDeps, ledger: Ledger, lines: string[]): Promise<void> {
  try {
    const from = deps.bucket?.copied(ledger.ledgerId) ?? 0;
    const todo = ledger.entries.filter((e) => e.seq > from);
    if (!todo.length) return;
    const problem = await deps.db.copyToBucket(ledger.ledgerId, todo);
    if (problem) lines.push(`bucket copy (evidence only, not relied on) failed: ${problem}; it is retried by the next destroy or recovery`);
    else deps.bucket?.mark(ledger.ledgerId, todo[todo.length - 1]?.seq ?? from);
  } catch (e) {
    lines.push(`bucket copy (evidence only, not relied on) failed: ${(e as Error).message}`);
  }
}

/** `pnpm stack:keys destroy <tenant> [--version n]` (D7, BK1). */
export async function destroy(deps: ProtocolDeps, req: { readonly slug: string; readonly version?: number }): Promise<Result> {
  const crash = deps.crash ?? noCrash;
  const lock = await deps.lock('destroy');
  const lines: string[] = [];
  try {
    const opened = openLedger(deps);
    if ('problems' in opened) return { ok: false, lines: ['no authoritative ledger: nothing was destroyed', ...opened.problems] };
    const { ledger } = opened;
    const levelled = ledger.level();
    if (levelled.length) return { ok: false, lines: ['the ledger copies could not be brought level: nothing was destroyed', ...levelled] };
    const { ops, problems } = opStates(ledger.entries);
    if (problems.length) return { ok: false, lines: ['the ledger is inconsistent: run `pnpm stack:keys recover`', ...problems] };
    const open = unresolved(ops);
    if (open.length) return { ok: false, lines: [`an earlier destruction is unresolved (${open.join(', ')}): run \`pnpm stack:keys recover\` first`] };

    // The read-only check (E7's for a retired version). Refused: nothing is written anywhere.
    const check = await deps.db.check(req.slug, req.version);
    if (!check.eligible) return { ok: false, lines: [`refused before anything was written: ${check.why}`] };

    const op = randomUUID();
    try {
      ledger.append(
        { type: 'pending', op, tenant: { id: check.tenantId, slug: req.slug }, kind: check.kind, versions: check.versions, requestedAt: new Date().toISOString(), preconditions: check.preconditions },
        'pending',
      );
    } catch (e) {
      if (!(e instanceof LedgerWriteError)) throw e;
      // D7: a destination that can't be written stops it before the database. Where `pending` did land, `aborted`
      // follows (the outcome is known: the database was never touched), so recovery never rolls it forward.
      if (e.written.length) {
        try {
          ledger.append({ type: 'aborted', op, reason: 'destination_unavailable' }, 'aborted');
        } catch {
          lines.push('the aborted record could not reach every destination either: `pnpm stack:keys recover` settles it once they are back');
        }
      }
      return { ok: false, op, lines: [`stopped before the database: ${e.problem}`, ...lines] };
    }
    crash('db:before');
    const outcome = await deps.db.destroy(op, req.slug, req.version);
    crash('db:after');

    if (outcome.outcome === 'unknown')
      return { ok: false, op, lines: [`the database step's outcome is unknown (${outcome.detail}): the destruction is pending, not accepted. Run \`pnpm stack:keys recover\`: it completes it from the database's evidence.`] };
    if (outcome.outcome === 'refused') {
      try {
        ledger.append({ type: 'aborted', op, reason: outcome.why }, 'aborted');
      } catch (e) {
        if (!(e instanceof LedgerWriteError)) throw e;
        return { ok: false, op, lines: [`refused by the database (${outcome.why}); the aborted record is not durable everywhere (${e.problem}): run \`pnpm stack:keys recover\``] };
      }
      return { ok: false, op, lines: [`refused by the database, nothing destroyed: ${outcome.why} (recorded as aborted)`] };
    }
    if (outcome.tenantId !== check.tenantId || outcome.kind !== check.kind)
      return { ok: false, op, lines: ['the database step reported a different destruction than was asked: run `pnpm stack:keys recover`, which stops on conflicting evidence'] };
    try {
      ledger.append({ type: 'committed', op, versions: outcome.versions, destroyedAt: outcome.destroyedAt, auditSeq: outcome.auditSeq, by: 'destroy' }, 'committed');
    } catch (e) {
      if (!(e instanceof LedgerWriteError)) throw e;
      return { ok: false, op, lines: [`the keys are destroyed, but the committed record is not durable everywhere (${e.problem}): NOT accepted yet. Run \`pnpm stack:keys recover\` once the destination is back.`] };
    }
    crash('report:before');
    await copyBacklog(deps, ledger, lines);
    return {
      ok: true,
      op,
      lines: [`${req.slug}: ${outcome.kind === 'TENANT' ? 'every key' : `v${outcome.versions.join(', v')}`} destroyed and accepted (op ${op}, audit seq ${outcome.auditSeq})`, ...outcome.forget, ...lines],
    };
  } finally {
    lock.release();
  }
}

/** Does this row match the destruction the ledger records, with its audit event and the keys' state? (D8) */
function rowProblem(row: EvidenceRow, pending: OpState['pending'], versions: readonly number[]): string | null {
  if (row.tenantId !== pending.tenant.id) return 'its row is for another tenant';
  if (row.kind !== pending.kind) return `its row is a ${row.kind} destruction`;
  if (!same(row.versions, versions)) return `its row names versions ${row.versions.join(',')}, the ledger ${versions.join(',')}`;
  if (!row.audit) return 'the audit event its row names is missing';
  if (row.audit.op !== row.op || row.audit.tenantId !== row.tenantId || !['crypto.tenant_key.destroyed', 'crypto.tenant_key.reapplied'].includes(row.audit.action))
    return 'the audit event its row names does not record this destruction';
  return null;
}

const notDestroyed = (versions: readonly number[], keys: readonly KeyState[]) =>
  versions.filter((v) => {
    const k = keys.find((x) => x.version === v);
    return k !== undefined && (k.status !== 'DESTROYED' || !k.wrapErased);
  });

/** D8: the routine every deploy and restore runs, and `pnpm stack:keys recover`. Fails closed on anything it can't decide. */
export async function recover(deps: ProtocolDeps, holder = 'recover'): Promise<Result> {
  const crash = deps.crash ?? noCrash;
  const lock = await deps.lock(holder);
  const lines: string[] = [];
  const stop = (why: string): Result => ({ ok: false, lines: [...lines, `STOP: ${why}`] });
  try {
    const opened = openLedger(deps);
    if ('problems' in opened) return { ok: false, lines: ['STOP: no authoritative ledger can be established', ...opened.problems] };
    const { ledger } = opened;
    const levelled = ledger.level();
    if (levelled.length) return { ok: false, lines: ['STOP: the ledger copies could not be brought level', ...levelled] };
    const { ops, problems } = opStates(ledger.entries);
    if (problems.length) return { ok: false, lines: ['STOP: the ledger is inconsistent', ...problems] };

    const ev = await deps.db.evidence([...new Set([...ops.values()].map((s) => s.pending.tenant.id))]);
    const rows = new Map(ev.rows.map((r) => [r.op, r]));
    for (const r of ev.rows) if (!ops.has(r.op)) return stop(`the database holds a key_destruction row for op ${r.op}, which the ledger lacks`);

    let reapplied = 0;
    let completed = 0;
    for (const s of ops.values()) {
      const { op } = s.pending;
      const row = rows.get(op);
      const keys = ev.tenants[s.pending.tenant.id] ?? [];
      if (s.outcome?.type === 'aborted') {
        if (row) return stop(`op ${op} is recorded as aborted, but the database holds its key_destruction row`);
        continue;
      }
      if (s.outcome?.type === 'committed') {
        const versions = s.outcome.versions;
        if (row) {
          const p = rowProblem(row, s.pending, versions);
          if (p) return stop(`committed op ${op}: conflicting evidence: ${p}`);
        }
        const back = notDestroyed(versions, keys);
        // TENANT: every live key goes; the listed versions decide whether a restore brought any back.
        if (row && back.length === 0) continue;
        // None of its versions exists in this database (a reset demo database, or a restore from before the tenant's
        // keys existed): nothing can decrypt with them, so it holds. Reported, never a row for a tenant that isn't there.
        if (!row && !keys.some((k) => versions.includes(k.version))) {
          lines.push(`op ${op} (${s.pending.tenant.slug}): none of its key versions exists in this database: in force, nothing to destroy again`);
          continue;
        }
        const r = await deps.db.reapply(op, s.pending.tenant.id, s.pending.kind, versions);
        crash(`reapply:${op}`);
        if (r.outcome !== 'reapplied') return stop(`committed op ${op}: its keys could not be destroyed again (${r.outcome === 'refused' ? r.why : r.detail})`);
        ledger.append({ type: 'reapplied', op, destroyedNow: r.destroyed, recorded: r.recorded, activeDestroyed: r.activeDestroyed }, `reapplied:${op}`);
        reapplied++;
        lines.push(`op ${op} (${s.pending.tenant.slug}): re-applied after a restore, versions ${r.destroyed.join(',') || 'none'} destroyed again${r.recorded ? ', its row recorded again' : ''}`);
        if (r.activeDestroyed) lines.push(`  WARNING: ${s.pending.tenant.slug}'s ACTIVE key was among them (the restore predates its retirement): the tenant has no active key until one is provisioned`);
        continue;
      }
      // pending with no outcome: the database's own evidence decides (D8).
      if (row) {
        const p = rowProblem(row, s.pending, s.pending.versions) ?? (notDestroyed(row.versions, keys).length ? 'its keys are not all destroyed' : null);
        if (p) return stop(`pending op ${op}: conflicting evidence: ${p}`);
        ledger.append({ type: 'committed', op, versions: row.versions, destroyedAt: row.destroyedAt, auditSeq: row.auditSeq, by: 'recovery' }, `committed:${op}`);
        completed++;
        lines.push(`op ${op} (${s.pending.tenant.slug}): its transaction had committed; recorded as committed from the database's evidence`);
        continue;
      }
      // No row: the transaction never committed, or a restore took it back. Roll forward, re-checked in its transaction.
      const out = await deps.db.destroy(op, s.pending.tenant.slug, s.pending.kind === 'RETIRED' ? s.pending.versions[0] : undefined);
      crash(`rollforward:${op}`);
      if (out.outcome === 'refused') return stop(`pending op ${op} (${s.pending.tenant.slug}): its preconditions no longer hold (${out.why}). Nothing was destroyed. Decide, then: \`pnpm stack:keys ledger abandon ${op} --reason …\``);
      if (out.outcome === 'unknown') return stop(`pending op ${op}: the roll-forward's outcome is unknown (${out.detail}); run recovery again`);
      if (out.tenantId !== s.pending.tenant.id || out.kind !== s.pending.kind) return stop(`pending op ${op}: the roll-forward reported a different destruction`);
      ledger.append({ type: 'committed', op, versions: out.versions, destroyedAt: out.destroyedAt, auditSeq: out.auditSeq, by: 'recovery' }, `committed:${op}`);
      completed++;
      lines.push(`op ${op} (${s.pending.tenant.slug}): rolled forward and committed`);
    }
    await copyBacklog(deps, ledger, lines);
    lines.unshift(`ledger ${ledger.ledgerId}: authoritative on ${String(ledger.destinations.length)} destination(s); ${String(ops.size)} destruction(s) recorded, ${String(completed)} completed now, ${String(reapplied)} re-applied`);
    return { ok: true, lines };
  } catch (e) {
    if (e instanceof LedgerWriteError) return stop(`a recovery record is not durable everywhere: ${e.problem}`);
    throw e;
  } finally {
    lock.release();
  }
}

/**
 * The owner's way out of D8's stop on a pending op whose preconditions no longer hold: records it as aborted, only
 * when the database holds no row for it (it never committed) and with the owner's reason. Never for a committed op.
 */
export async function abandon(deps: ProtocolDeps, op: string, reason: string): Promise<Result> {
  if (reason.trim().length < 8) return { ok: false, lines: ['a reason is required (--reason "…")'] };
  const lock = await deps.lock('abandon');
  try {
    const opened = openLedger(deps);
    if ('problems' in opened) return { ok: false, lines: ['no authoritative ledger', ...opened.problems] };
    const { ledger } = opened;
    const levelled = ledger.level();
    if (levelled.length) return { ok: false, lines: levelled };
    const s = opStates(ledger.entries).ops.get(op);
    if (!s) return { ok: false, lines: [`no op ${op} in the ledger`] };
    if (s.outcome) return { ok: false, lines: [`op ${op} is already ${s.outcome.type}: nothing to abandon`] };
    const ev = await deps.db.evidence([s.pending.tenant.id]);
    if (ev.rows.some((r) => r.op === op)) return { ok: false, lines: [`op ${op} committed in the database: run \`pnpm stack:keys recover\`, which records it`] };
    ledger.append({ type: 'aborted', op, reason: `abandoned by the owner: ${reason.trim()}` }, 'aborted');
    await deps.db.audit('op_abandoned', { op, tenantId: s.pending.tenant.id, reason: reason.trim() });
    return { ok: true, op, lines: [`op ${op} recorded as aborted (abandoned); nothing was destroyed`] };
  } finally {
    lock.release();
  }
}
