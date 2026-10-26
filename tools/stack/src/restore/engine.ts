// Spec 0020 B2-5, B2-6: one routine restores a backup set, either into the rehearsal's own project (`univarse-restore`,
// torn down afterwards) or into the stack itself (`stack:restore`, B2-12). Every side effect is a step in RestoreDeps,
// so the order, every stop, and the teardown on every failure are unit-tested without Docker (BK6). The decisions on
// the checks' reports are restore/checks.ts's.
//
// The order (B2-6): the key and the set → the target prepared (a crashed rehearsal's leftovers removed; for a real
// restore, the stack down and its data copied aside) → the real ledger's heads read → the registry lock, and the set's
// release verified → the configuration from the set's own parts → the WAL the target needs (shipped and waited for)
// → PostgreSQL recovered to the target → Vault from its snapshot, unsealed with the set's key, its tokens made good
// (spec 0023) → SeaweedFS and the files → PgBouncer → the checks before recovery → the ledger's recovery → the checks
// after it → the real ledger's heads again → the record. A rehearsal is torn down in a `finally`, whatever happened.
import type { KeyObject } from 'node:crypto';
import { walFileName } from '../backup/pgbase.js';
import type { Entry } from '../ledger/chain.js';
import type { OpenedSet } from './artifact.js';
import { afterProblems, checkpointOf, controlProblems, countProblems, destroyedTenants, type DecryptReport, type Facts } from './checks.js';
import { walNeed } from './wal-range.js';

export type Mode = 'rehearsal' | 'restore';

export interface RestoreRequest {
  readonly mode: Mode;
  /** The set to restore; the newest complete one when absent. */
  readonly setId?: string;
  /** `--to`: a recovery_target_time instead of the set's own position (B2-6 step 5). */
  readonly to?: Date;
  /** The drill's tenant (B2-11): it must decrypt before recovery, and be destroyed after. */
  readonly drill?: string;
}

/** Where PostgreSQL recovers to. */
export type RecoveryTarget = { readonly lsn: string } | { readonly time: Date };

export interface Job<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly lines: readonly string[];
}

export interface RestoreDeps {
  log(line: string): void;
  now(): Date;
  /** Step 1: the private key from `--key` and the passphrase; throws, naming neither, when it doesn't open. */
  openKey(): KeyObject;
  openSet(setId: string | undefined, key: KeyObject): Promise<{ ok: true; set: OpenedSet } | { ok: false; problems: readonly string[] }>;
  /** A rehearsal: a crashed run's labelled project removed. A real restore: its refusals, then the stack's data copied aside. */
  prepareTarget(set: OpenedSet): Promise<readonly string[]>;
  /** The real ledger's heads (read-only), compared before and after (B2-6 step 12). */
  realHeads(): { ok: true; key: string } | { ok: false; problems: readonly string[] };
  /** Step 2, held to the end: no backup, prune, deploy or release runs meanwhile, and the shipper is ours to call. */
  lockRegistry(holder: string): { release(): void };
  /** The release record the set's deployed digests name, verified as the deploy verifies one, with its own commit. */
  verifyRelease(deployed: Readonly<Record<string, string>>): { ok: true; images: Readonly<Record<string, string>>; record: string } | { ok: false; problems: readonly string[] };
  /** Step 4: the set's own parts rendered into the target's configuration (env files, configs, certificates, volumes). */
  configure(set: OpenedSet, images: Readonly<Record<string, string>>): Promise<readonly string[]>;
  /** Step 5's inputs: the shipped WAL on a timeline (bare names), and shipping what is staged now. */
  shippedWal(timeline: number): readonly string[];
  shipWal(): Promise<readonly string[]>;
  sleep(ms: number): Promise<void>;
  /** The age of the newest shipped segment, for the RPO reached (B2-11). */
  newestShippedAt(timeline: number): Date | null;
  restorePostgres(set: OpenedSet, wal: readonly string[], target: RecoveryTarget): Promise<readonly string[]>;
  /** Step 6: Vault from the set's snapshot, unsealed with the set's own key. */
  restoreVault(set: OpenedSet): Promise<readonly string[]>;
  /** Spec 0023 on the restored Vault: a dead token re-issued, and the env files rendered with the tokens. */
  vaultTokens(): { ok: boolean; lines: readonly string[] };
  /** Step 7: SeaweedFS started, its buckets, and every file written through the filer and read back over S3 (B2-8). */
  restoreFiles(set: OpenedSet): Promise<{ readonly objects: number; readonly problems: readonly string[] }>;
  /** Step 8: services started healthy, by name. */
  start(services: readonly string[]): readonly string[];
  /** The jobs, from the verified release, in the target's project. */
  migrateCheck(): Job<null>;
  facts(): Job<Facts>;
  verifyChains(checkpoint: ReturnType<typeof checkpointOf> | null): Job<{ readonly ok: boolean; readonly problems: readonly string[] }>;
  verifyUnwrap(): Job<{ readonly ok: boolean; readonly keys: number; readonly unwrapped: number }>;
  verifyDecrypt(): Job<DecryptReport>;
  /** Step 10: D8's recovery, on the scratch ledger (rehearsal) or the real one (restore); and that ledger's entries after. */
  recover(): Promise<{ readonly ok: boolean; readonly lines: readonly string[]; readonly entries: readonly Entry[] }>;
  /** A rehearsal's teardown (labelled project, volumes, temporary directory, scratch ledger); a restore's project stopped. */
  teardown(): readonly string[];
  /** The peak memory of the target's containers, sampled while it runs (B2-11). */
  memory(): { stop(): number | null };
}

export interface RestoreRecord {
  readonly mode: Mode;
  readonly setId: string;
  readonly release: string;
  readonly target: string;
  readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[];
  /** From the first unseal to the last check (B2-11). */
  readonly rtoSeconds: number | null;
  /** How old the newest shipped WAL segment was when the restore began: what a restore then would have lost. */
  readonly rpoSeconds: number | null;
  readonly peakMemoryMb: number | null;
  readonly decryptBefore: DecryptReport | null;
  readonly decryptAfter: DecryptReport | null;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly record: RestoreRecord | null;
}

/** B2-7: the rehearsal ships every 30 s for up to 6 minutes before giving up on the target's segment. */
export const WAL_WAIT = { everyMs: 30_000, forMs: 6 * 60_000 } as const;

export async function restore(req: RestoreRequest, deps: RestoreDeps): Promise<RestoreResult> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.log(l);
  };
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    say(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
    return ok;
  };
  // The result shares `lines`, so the teardown's lines (added in the `finally`) are part of it.
  const stop = (why: readonly string[] | string): RestoreResult => {
    for (const w of typeof why === 'string' ? [why] : why) say(`STOP: ${w}`);
    return { ok: false, lines, record: null };
  };
  const fail = () => stop('a check failed (above)');
  let lock: { release(): void } | null = null;
  let memory: { stop(): number | null } | null = null;
  let prepared = false;
  try {
    // ── 1. The key and the set, before anything is created.
    let key: KeyObject;
    try {
      key = deps.openKey();
    } catch (e) {
      return stop(`the backup key does not open: ${(e as Error).message}`);
    }
    const opened = await deps.openSet(req.setId, key);
    if (!opened.ok) return stop(opened.problems);
    const { set } = opened;
    const m = set.manifest;
    say(`set ${set.index.setId} (${m.createdAt}): ${String(set.index.files.length)} sealed files match their index; the manifest opens`);
    if (req.to !== undefined && req.to.getTime() < new Date(m.createdAt).getTime())
      return stop(`--to ${req.to.toISOString()} is before set ${set.index.setId} was taken (${m.createdAt}): restore an earlier set`);
    const before = req.mode === 'rehearsal' ? deps.realHeads() : null;
    if (before && !before.ok) return stop(["the real shred ledger can't be read before the rehearsal:", ...before.problems]);
    const startedAt = deps.now();
    const newest = deps.newestShippedAt(m.postgres.timeline);
    const rpoSeconds = newest ? Math.max(0, Math.round((startedAt.getTime() - newest.getTime()) / 1000)) : null;

    // ── 2. The registry lock, held to the end; then the set's release, verified.
    lock = deps.lockRegistry(req.mode === 'rehearsal' ? 'restore rehearsal' : 'restore');
    prepared = true;
    const problems = await deps.prepareTarget(set);
    if (problems.length) return stop(problems);
    const release = deps.verifyRelease(m.deployed);
    if (!release.ok) return stop(release.problems);
    say(`release ${release.record}: verified`);
    memory = deps.memory();

    // ── 4. The configuration, from the set's own parts.
    const configured = await deps.configure(set, release.images);
    if (configured.length) return stop(configured);

    // ── 5. The WAL the target needs, then PostgreSQL recovered to it.
    const facts = m.facts as Facts;
    const target: RecoveryTarget = req.to === undefined ? { lsn: facts.platform.lsn } : { time: req.to };
    const targetSegment = 'lsn' in target ? walFileName(target.lsn, m.postgres.timeline) : 'newest';
    let wal: readonly string[] | null = null;
    for (let waited = 0; ; waited += WAL_WAIT.everyMs) {
      for (const l of await deps.shipWal()) say(l);
      const need = walNeed(m.postgres.startWal, m.postgres.timeline, targetSegment, deps.shippedWal(m.postgres.timeline));
      if (need.state === 'complete') {
        wal = need.files;
        break;
      }
      if (need.state === 'gap') return stop(`WAL segment ${need.missing} is missing, and later ones were shipped: a gap no wait can fill`);
      if (need.state === 'no-history') return stop(`the timeline's history file ${need.missing} isn't shipped`);
      if (waited >= WAL_WAIT.forMs)
        return stop(`the segment holding this set's target hasn't been archived yet (${need.missing.join(', ')}; newest shipped: ${need.newestShipped ?? 'none'}): run this again in a few minutes`);
      say(`waiting for WAL ${need.missing.join(', ')} (PostgreSQL closes a quiet segment within 5 minutes)`);
      await deps.sleep(WAL_WAIT.everyMs);
    }
    say(`WAL: ${String(wal.length)} files, ${m.postgres.startWal} onwards`);
    const pg = await deps.restorePostgres(set, wal, target);
    if (pg.length) return stop(pg);
    say(`PostgreSQL recovered to ${'lsn' in target ? `the set's position ${target.lsn}` : target.time.toISOString()}`);

    // ── 6. Vault: the snapshot, the set's own unseal key, and its tokens.
    const firstUnseal = deps.now();
    const vault = await deps.restoreVault(set);
    if (vault.length) return stop(vault);
    const tokens = deps.vaultTokens();
    for (const l of tokens.lines) say(`vault: ${l}`);
    if (!tokens.ok) return stop("the restored Vault's tokens could not be made good");

    // ── 7, 8. The files, then PgBouncer and Valkey.
    const files = await deps.restoreFiles(set);
    if (!check('files', files.problems.length === 0, files.problems.length ? files.problems.join('; ') : `${String(files.objects)} objects written through the filer, each read back over S3 with its SHA-256 equal`)) return fail();
    const started = deps.start(['pgbouncer', 'valkey']);
    if (started.length) return stop(started);

    // ── 9. The checks before recovery.
    const mig = deps.migrateCheck();
    if (!check('migrations and RLS', mig.ok, mig.ok ? 'migrate --check-only: no pending migration, rls:check passes' : mig.lines.join(' | '))) return fail();
    const chains = deps.verifyChains(checkpointOf(facts));
    if (!check('audit chains at the checkpoint', chains.ok && chains.value?.ok === true, chains.value?.problems.join('; ') || (chains.ok ? 'every chain verifies, and holds its recorded head' : chains.lines.join(' | ')))) return fail();
    const got = deps.facts();
    if (!got.ok || !got.value) return stop(['the keys job could not read the restored facts', ...got.lines]);
    if ('lsn' in target) {
      const diff = countProblems(facts, got.value);
      if (!check('row counts', diff.length === 0, diff.length ? diff.join('; ') : `equal to the set's, platform and ${String(Object.keys(facts.tenants).length)} tenants`)) return fail();
    } else say(`row counts at ${target.time.toISOString()} (reported, not compared: a later time holds more rows): platform ${JSON.stringify(got.value.platform.counts)}`);
    const unwrap = deps.verifyUnwrap();
    if (!check('data keys unwrap', unwrap.ok && unwrap.value?.ok === true, unwrap.value ? `${String(unwrap.value.unwrapped)} of ${String(unwrap.value.keys)}` : unwrap.lines.join(' | '))) return fail();
    const decryptBefore = deps.verifyDecrypt();
    if (!decryptBefore.ok || !decryptBefore.value) return stop(['the keys job could not verify decryption', ...decryptBefore.lines]);

    // ── 10. Recovery (D8), then the checks after it.
    const rec = await deps.recover();
    for (const l of rec.lines) say(`ledger: ${l}`);
    if (!check('recovery', rec.ok, rec.ok ? 'the ledger\'s destructions made to hold' : 'stopped (see the ledger lines)')) return fail();
    const destroyed = destroyedTenants(rec.entries, m.ledger);
    const control = controlProblems(decryptBefore.value, { destroyedBefore: destroyed.before, ...(req.drill === undefined ? {} : { drill: req.drill }) });
    if (!check('control: decryption before recovery', control.length === 0, control.length ? control.join('; ') : summary(decryptBefore.value))) return fail();
    const decryptAfter = deps.verifyDecrypt();
    if (!decryptAfter.ok || !decryptAfter.value) return stop(['the keys job could not verify decryption after recovery', ...decryptAfter.lines]);
    const after = afterProblems(decryptBefore.value, decryptAfter.value, { accepted: destroyed.accepted, ...(req.drill === undefined ? {} : { drill: req.drill }) });
    if (!check('decryption after recovery', after.length === 0, after.length ? after.join('; ') : summary(decryptAfter.value))) return fail();
    const unwrapAfter = deps.verifyUnwrap();
    if (!check('data keys unwrap after recovery', unwrapAfter.ok && unwrapAfter.value?.ok === true, unwrapAfter.value ? `${String(unwrapAfter.value.unwrapped)} of ${String(unwrapAfter.value.keys)}` : unwrapAfter.lines.join(' | '))) return fail();
    const chainsAfter = deps.verifyChains(null);
    if (!check('audit chains after recovery', chainsAfter.ok && chainsAfter.value?.ok === true, chainsAfter.value?.problems.join('; ') || 'every chain verifies, with recovery\'s own events')) return fail();
    const rtoSeconds = Math.round((deps.now().getTime() - firstUnseal.getTime()) / 1000);

    // ── 12. The real ledger, untouched by a rehearsal.
    if (before?.ok) {
      const now = deps.realHeads();
      if (!check('the real ledger unchanged', now.ok && now.key === before.key, now.ok ? (now.key === before.key ? 'its heads are as before' : 'its heads changed during the rehearsal') : now.problems.join('; '))) return fail();
    }
    const peak = memory.stop();
    memory = null;
    const record: RestoreRecord = {
      mode: req.mode,
      setId: set.index.setId,
      release: release.record,
      target: 'lsn' in target ? `the set's position ${target.lsn}` : target.time.toISOString(),
      checks,
      rtoSeconds,
      rpoSeconds,
      peakMemoryMb: peak,
      decryptBefore: decryptBefore.value,
      decryptAfter: decryptAfter.value,
    };
    say(`every check passed; RTO ${String(rtoSeconds)} s${rpoSeconds === null ? '' : `, RPO reached ${String(rpoSeconds)} s`}`);
    return { ok: true, lines, record };
  } catch (e) {
    return stop(`the restore stopped: ${(e as Error).message}`);
  } finally {
    memory?.stop();
    // BK6: a rehearsal leaves nothing behind, whatever happened; a real restore's project is stopped, its data kept.
    if (prepared) for (const l of deps.teardown()) say(l);
    lock?.release();
  }
}

const summary = (r: DecryptReport) => {
  const by = new Map<string, number>();
  for (const v of Object.values(r)) by.set(v.status, (by.get(v.status) ?? 0) + 1);
  return [...by].map(([s, n]) => `${String(n)} ${s}`).join(', ');
};
