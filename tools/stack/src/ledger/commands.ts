// Spec 0020 D7, D8, BK16 (A2-3): the ledger's configuration commands. Each is the owner's explicit act, holds the
// ledger lock, keeps the guarantee (no accepted destruction can be lost through it), and is recorded in the chain
// and the platform audit. A backup set's copy or the bucket's can never be the source of anything here.
//   init                       once, for a stack that has never had a ledger (never automatic: A2-3)
//   add-destination <path>     an external drive, say: the whole chain copied, then a config entry everywhere
//   rebuild-destination <path> [--from <path>]  a lost, emptied or swapped copy, from a configured destination's own
//   remove-destination <path>  one gone for good, while the others stand
//   status
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { destinationsOf, HISTORY_STATEMENT, nextEntry, opStates, type Destination, type Entry, type History } from './chain.js';
import { establishAuthority, Ledger, LedgerWriteError } from './ledger.js';
import type { LegacyEvidence, ProtocolDeps, Result } from './protocol.js';
import { createCopy, readCopy, readCopyAt, realFs, type Copy, type LedgerFs } from './store.js';

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const fsOf = (deps: ProtocolDeps): LedgerFs => deps.fs ?? realFs;
const newId = () => `dest-${randomUUID().slice(0, 8)}`;
const crashOf = (deps: ProtocolDeps) => (deps.crash ? { crash: deps.crash } : {});

/** BK16: the database must hold nothing the copy lacks (no key_destruction op it doesn't record). */
async function evidenceProblem(deps: ProtocolDeps, entries: readonly Entry[]): Promise<string | null> {
  const known = new Set(opStates(entries).ops.keys());
  const ev = await deps.db.evidence([]);
  const missing = ev.rows.filter((r) => !known.has(r.op)).map((r) => r.op);
  return missing.length ? `the database holds key_destruction op(s) this copy lacks: ${missing.join(', ')}` : null;
}

const writeFailure = (e: unknown): Result => {
  if (e instanceof LedgerWriteError) return { ok: false, lines: [`the config entry is not durable everywhere: ${e.problem}; run \`pnpm stack:keys recover\` once it is back`] };
  throw e;
};

/**
 * The owner's review of A2: what the database shows was destroyed before the ledger existed, reconciled into the plan
 * genesis records, or the reasons it can't be. Trustworthy only when it is consistent: every destroyed key has its wrap
 * erased and an audit event recording its destruction, and every destruction audit event's keys are destroyed now. An
 * event whose keys are live again is exactly what a restore before the ledger would leave: init refuses, because a
 * genesis must not imply that history is captured when it isn't.
 */
export function reconcileHistory(legacy: LegacyEvidence): { ok: true; adopted: History['adopted'] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const name = (id: string | null) => legacy.tenants.find((t) => t.id === id)?.slug ?? id ?? 'no tenant';
  const covered = new Map<string, string[]>(); // "<tenant>:<version>" → the audit seqs recording it
  for (const a of legacy.audits) {
    if (!a.tenantId || a.versions.length === 0) {
      problems.push(`audit event seq ${a.seq} records a destruction without naming its tenant and versions`);
      continue;
    }
    if (a.op) problems.push(`audit event seq ${a.seq} names op ${a.op}, but the database holds no key_destruction row for it`);
    const keys = legacy.tenants.find((t) => t.id === a.tenantId)?.keys ?? [];
    for (const v of a.versions) {
      const k = keys.find((x) => x.version === v);
      if (k?.status !== 'DESTROYED' || !k.wrapErased)
        problems.push(`audit event seq ${a.seq} records the destruction of ${name(a.tenantId)} v${String(v)}, but that key is ${k ? k.status : 'missing'} now (a restore may have undone it before the ledger existed)`);
      covered.set(`${a.tenantId}:${String(v)}`, [...(covered.get(`${a.tenantId}:${String(v)}`) ?? []), a.seq]);
    }
  }
  const adopted: History['adopted'][number][] = [];
  for (const t of legacy.tenants) {
    const destroyed = t.keys.filter((k) => k.status === 'DESTROYED');
    if (!destroyed.length) continue;
    for (const k of destroyed) {
      if (!k.wrapErased) problems.push(`${t.slug ?? t.id} v${String(k.version)} is DESTROYED but its wrap is not erased`);
      if (!covered.has(`${t.id}:${String(k.version)}`)) problems.push(`${t.slug ?? t.id} v${String(k.version)} is destroyed, but no audit event records its destruction`);
    }
    if (!t.slug) {
      problems.push(`destroyed keys of a tenant that no longer exists (${t.id})`);
      continue;
    }
    const versions = destroyed.map((k) => k.version);
    adopted.push({
      op: randomUUID(),
      tenant: { id: t.id, slug: t.slug },
      kind: t.keys.every((k) => k.status === 'DESTROYED') ? 'TENANT' : 'RETIRED',
      versions,
      auditSeqs: [...new Set(versions.flatMap((v) => covered.get(`${t.id}:${String(v)}`) ?? []))],
    });
  }
  return problems.length ? { ok: false, problems } : { ok: true, adopted };
}

export async function init(deps: ProtocolDeps, extra: readonly string[] = []): Promise<Result> {
  const fs = fsOf(deps);
  const lock = await deps.lock('ledger init');
  try {
    const p = readCopy(deps.primary, fs);
    if (p.state !== 'missing' && p.state !== 'empty') return { ok: false, lines: [`${deps.primary.path} already holds a ledger (or something else): init never runs over one`] };
    const ev = await deps.db.evidence([]);
    if (ev.rows.length)
      return {
        ok: false,
        lines: [`the database already records ${String(ev.rows.length)} destruction(s): this stack had a ledger. Rebuild it from a destination that still holds it (\`ledger rebuild-destination\`); never start a new one over it.`],
      };
    // What came before the ledger: reconciled into genesis, or init refuses (the owner's review of A2).
    const legacy = (await deps.db.evidence([], { legacy: true })).legacy;
    if (!legacy) return { ok: false, lines: ["the database's evidence came without its history (an older keys job?): nothing initialised"] };
    const history = reconcileHistory(legacy);
    if (!history.ok)
      return {
        ok: false,
        lines: [
          "the database's history of destructions from before the ledger can't be established, so no ledger was started (a genesis would imply it was captured):",
          ...history.problems.map((p) => `  ${p}`),
          'Investigate and settle each one (re-destroy a key whose destruction a restore undid, or restore the database that holds it); init accepts only a consistent history.',
        ],
      };
    const others: Destination[] = extra.map((path) => ({ id: newId(), path: resolve(path) }));
    for (const d of others) {
      const c = readCopy(d, fs);
      if (c.state !== 'missing' && c.state !== 'empty') return { ok: false, lines: [`${d.path} is not empty: choose an empty directory`] };
    }
    const ledgerId = randomUUID();
    const destinations = [deps.primary, ...others];
    const genesis = nextEntry(null, {
      type: 'genesis',
      ledgerId,
      generation: 1,
      destinations,
      history: { capturedAt: new Date().toISOString(), statement: HISTORY_STATEMENT, adopted: history.adopted },
    });
    // The other destinations first, the primary last: a failure leaves no primary, so nothing half-made is authoritative.
    const made: Destination[] = [];
    for (const d of [...others, deps.primary]) {
      const problem = createCopy(d, [genesis], fs);
      if (problem) {
        for (const m of made) fs.remove(resolve(m.path, ledgerId));
        return { ok: false, lines: [`init failed, nothing kept: ${problem}`] };
      }
      made.push(d);
    }
    // The adoptions genesis planned, each pending, recorded in the database (nothing destroyed), then committed. A stop
    // here leaves them for recovery, which completes the plan.
    const opened = Ledger.open(deps.primary, { fs, ...crashOf(deps) });
    if ('problems' in opened) return { ok: false, lines: ['initialised, but not authoritative', ...opened.problems] };
    deps.crash?.('init:genesis'); // D13: genesis durable everywhere, no adoption recorded yet
    for (const a of history.adopted) {
      opened.ledger.append({ type: 'pending', op: a.op, tenant: a.tenant, kind: a.kind, versions: a.versions, requestedAt: new Date().toISOString(), preconditions: { auditSeqs: a.auditSeqs }, adoption: true }, `pending:${a.op}`);
      const r = await deps.db.adopt(a.op, a.tenant.id, a.kind, a.versions);
      if (r.outcome !== 'adopted') return { ok: false, lines: [`initialised, but adopting ${a.tenant.slug}'s earlier destruction failed (${r.outcome === 'refused' ? r.why : r.detail}): run \`pnpm stack:keys recover\``] };
      opened.ledger.append({ type: 'committed', op: a.op, versions: r.versions, destroyedAt: r.destroyedAt, auditSeq: r.auditSeq, by: 'adoption' }, `committed:${a.op}`);
    }
    await deps.db.audit('initialised', { ledgerId, destinations: destinations.map((d) => d.id), adopted: history.adopted.length });
    return {
      ok: true,
      lines: [
        `ledger ${ledgerId} initialised on ${destinations.map((d) => d.path).join(', ')}`,
        `history before it: ${String(history.adopted.length)} destruction(s) adopted from the database's evidence. ${HISTORY_STATEMENT}`,
      ],
    };
  } finally {
    lock.release();
  }
}

export async function addDestination(deps: ProtocolDeps, path: string): Promise<Result> {
  const fs = fsOf(deps);
  const lock = await deps.lock('ledger add-destination');
  try {
    const opened = Ledger.open(deps.primary, { fs, ...crashOf(deps) });
    if ('problems' in opened) return { ok: false, lines: ['no authoritative ledger: nothing added', ...opened.problems] };
    const { ledger } = opened;
    const levelled = ledger.level();
    if (levelled.length) return { ok: false, lines: ['the copies could not be brought level: nothing added', ...levelled] };
    if (ledger.destinations.some((d) => samePath(d.path, path))) return { ok: false, lines: [`${path} is already a destination`] };
    const dest: Destination = { id: newId(), path: resolve(path) };
    const c = readCopy(dest, fs);
    if (c.state !== 'missing' && c.state !== 'empty') return { ok: false, lines: [`${dest.path} is not empty: choose an empty directory`] };
    // The copy first (not yet configured, so ignored if this stops here), then the config entry on every destination.
    const problem = createCopy(dest, ledger.entries, fs);
    if (problem) return { ok: false, lines: [problem] };
    ledger.adopt(dest, ledger.entries);
    ledger.append({ type: 'config', change: 'add', destination: dest, destinations: [...ledger.destinations, dest] }, 'config');
    await deps.db.audit('destination_added', { ledgerId: ledger.ledgerId, destination: dest.id });
    return { ok: true, lines: [`${dest.path} added as destination ${dest.id}: every later record must be durable on it too`] };
  } catch (e) {
    return writeFailure(e);
  } finally {
    lock.release();
  }
}

/**
 * Recreates a lost, emptied or swapped destination from a configured destination's OWN copy. The source must be
 * readable, carry the ledger's genesis, verify, be configured by its own ledger at that path, agree with every other
 * configured destination still readable (the furthest ahead of them is used), and hold every op the database records.
 * `--from` is needed only when the target is the primary (whose configuration names the others).
 */
export async function rebuildDestination(deps: ProtocolDeps, target: string, from?: string): Promise<Result> {
  const fs = fsOf(deps);
  const lock = await deps.lock('ledger rebuild-destination');
  try {
    const isPrimary = samePath(target, deps.primary.path);
    if (isPrimary && !from) return { ok: false, lines: ['the primary is rebuilt from another configured destination: --from <path>'] };
    const source: Copy = isPrimary && from ? readCopyAt(resolve(from), fs) : readCopy(deps.primary, fs);
    if (source.state !== 'ok') return { ok: false, lines: [`the source is not usable: ${source.state === 'invalid' ? source.problem : source.state}; nothing rebuilt`] };
    const config = destinationsOf(source.entries);
    const self = config.find((d) => d.id === source.identity.destinationId && samePath(d.path, source.dest.path));
    if (!self) return { ok: false, lines: [`${source.dest.path} is not a configured destination of its ledger (a backup set's or the bucket's copy can never be a source); nothing rebuilt`] };
    const dest = config.find((d) => samePath(d.path, target));
    if (!dest) return { ok: false, lines: [`${target} is not a configured destination`] };

    let best: Extract<Copy, { state: 'ok' }> = source;
    for (const d of config) {
      if (d.id === dest.id || d.id === self.id) continue;
      const c = readCopy(d, fs);
      if (c.state !== 'ok') continue;
      if (c.identity.ledgerId !== source.identity.ledgerId) return { ok: false, lines: [`${d.path} holds another ledger: nothing rebuilt`] };
      const [short, long] = c.entries.length < best.entries.length ? [c, best] : [best, c];
      if (short.entries.some((e, i) => e.hash !== long.entries[i]?.hash)) return { ok: false, lines: [`${d.path} and ${best.dest.path} diverge: nothing rebuilt`] };
      best = long;
    }
    const problem = await evidenceProblem(deps, best.entries);
    if (problem) return { ok: false, lines: [`${problem}: rebuilding from it would lose an accepted destruction; nothing rebuilt`] };

    const existing = readCopy(dest, fs);
    if (existing.state === 'ok' && existing.entries.length === best.entries.length && existing.entries.at(-1)?.hash === best.entries.at(-1)?.hash)
      return { ok: false, lines: [`${dest.path} is intact and current: nothing to rebuild`] };
    if (existing.state !== 'missing' && existing.state !== 'empty') {
      // Kept for evidence, never read again: moved aside inside the destination (a dot-name, which readCopy ignores).
      const aside = resolve(dest.path, `.replaced-${new Date().toISOString().replace(/[:.]/g, '')}`);
      fs.mkdirp(aside);
      for (const n of fs.list(dest.path) ?? []) if (!n.startsWith('.')) fs.rename(resolve(dest.path, n), resolve(aside, n));
    }
    const made = createCopy(dest, best.entries, fs);
    if (made) return { ok: false, lines: [`${made}; nothing rebuilt`] };
    // Every configured destination may be readable again now: record the rebuild through the authoritative ledger.
    const opened = Ledger.open(isPrimary ? dest : deps.primary, { fs, ...crashOf(deps) });
    if ('problems' in opened) return { ok: false, lines: [`${dest.path} rebuilt, but the ledger is still not authoritative`, ...opened.problems] };
    const levelled = opened.ledger.level();
    if (levelled.length) return { ok: false, lines: [`${dest.path} rebuilt, but the copies could not be brought level`, ...levelled] };
    opened.ledger.append({ type: 'config', change: 'rebuild', destination: dest, destinations: opened.ledger.destinations }, 'config');
    await deps.db.audit('destination_rebuilt', { ledgerId: opened.ledger.ledgerId, destination: dest.id, from: best.dest.id });
    return { ok: true, lines: [`${dest.path} rebuilt from ${best.dest.path} (${String(best.entries.length)} entries)`] };
  } catch (e) {
    return writeFailure(e);
  } finally {
    lock.release();
  }
}

/** Drops a destination gone for good, while every other configured destination stands on its own (never the primary). */
export async function removeDestination(deps: ProtocolDeps, path: string, reason: string): Promise<Result> {
  const fs = fsOf(deps);
  const lock = await deps.lock('ledger remove-destination');
  try {
    if (samePath(path, deps.primary.path)) return { ok: false, lines: ['the primary is never removed: rebuild it instead'] };
    if (reason.trim().length < 8) return { ok: false, lines: ['a reason is required (--reason "…")'] };
    const p = readCopy(deps.primary, fs);
    if (p.state !== 'ok') return { ok: false, lines: [`the primary is not usable (${p.state === 'invalid' ? p.problem : p.state}): rebuild it first`] };
    const gone = destinationsOf(p.entries).find((d) => samePath(d.path, path));
    if (!gone) return { ok: false, lines: [`${path} is not a configured destination`] };
    // The rest must be authoritative on their own: readable, verifying, agreeing, and holding every op.
    const opened = Ledger.open(deps.primary, { fs, exclude: gone.id, ...crashOf(deps) });
    if ('problems' in opened) return { ok: false, lines: ['the remaining destinations are not authoritative: nothing removed', ...opened.problems] };
    const { ledger } = opened;
    const problem = await evidenceProblem(deps, ledger.entries);
    if (problem) return { ok: false, lines: [`${problem}: nothing removed`] };
    const levelled = ledger.level();
    if (levelled.length) return { ok: false, lines: ['the copies could not be brought level: nothing removed', ...levelled] };
    ledger.drop(gone.id);
    const rest = ledger.destinations.filter((d) => d.id !== gone.id);
    ledger.append({ type: 'config', change: 'remove', destination: gone, destinations: rest, reason: reason.trim() }, 'config');
    await deps.db.audit('destination_removed', { ledgerId: ledger.ledgerId, destination: gone.id, reason: reason.trim() });
    return { ok: true, lines: [`${gone.path} removed from the ledger's destinations`] };
  } catch (e) {
    return writeFailure(e);
  } finally {
    lock.release();
  }
}

export function status(deps: ProtocolDeps): Result {
  const a = establishAuthority(deps.primary, fsOf(deps));
  if (!a.ok) return { ok: false, lines: ['NOT authoritative:', ...a.problems] };
  const { ops } = opStates(a.entries);
  const count = (t: string) => [...ops.values()].filter((s) => (s.outcome?.type ?? 'pending') === t).length;
  return {
    ok: true,
    lines: [
      `ledger ${a.ledgerId}: authoritative; ${String(a.entries.length)} entries`,
      ...a.destinations.map((d) => {
        const c = a.copies.find((x) => x.dest.id === d.id);
        return `  ${d.id} ${d.path}: ${String(c?.entries.length ?? 0)} entries${c && c.entries.length < a.entries.length ? ' (behind: levelled by the next recovery)' : ''}`;
      }),
      `destructions: ${String(count('committed'))} committed, ${String(count('aborted'))} aborted, ${String([...ops.values()].filter((s) => !s.outcome && !s.abandoned).length)} pending`,
      ...[...ops.values()].filter((s) => s.abandoned && !s.outcome).map((s) => `ABANDONED op ${s.pending.op} (${s.pending.tenant.slug}) since ${s.abandoned?.at ?? ''}: its outcome not established; the no-resurrection guarantee does not cover it`),
      ...(a.entries[0]?.type === 'genesis' && a.entries[0].history ? [`history before this ledger (${a.entries[0].history.capturedAt}): ${String(a.entries[0].history.adopted.length)} adopted. ${a.entries[0].history.statement}`] : []),
    ],
  };
}
