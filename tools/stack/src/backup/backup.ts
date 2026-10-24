// Spec 0020 D2, D5, D6, D14, BK3, B-6 to B-9: one backup set, in the Design's order.
//   the registry lock (a backup never races a deploy, a release or a prune) → the key and the destination, with D7's
//   external-drive rule → staged WAL shipped → pg_basebackup → Vault's Raft snapshot → the clean bucket's files → the
//   stack directory's parts → the facts (after the base backup: B-7) → the durable ledger, under the ledger lock
//   (taken after the registry lock, D14) → the sealed manifest → the clear index, which completes the set → pruning.
// Every artifact is sealed as it streams (D5). Any failure stops the backup: the set has no index, so it is ignored and
// pruned a day later, and both locks are released. Every step is a dependency, so the order is unit-tested.
import type { KeyObject } from 'node:crypto';
import type { LedgerSnapshot } from './ledger-snapshot.js';
import { newSetId, realSetFs, SetWriter, type ArtifactRecord, type SetFs, type SetIndex } from './set.js';
import { tarStream, type TarEntry } from './tar.js';
import type { ShipResult } from './wal.js';

export interface BaseBackup {
  readonly stream: AsyncIterable<Buffer>;
  /** pg_basebackup's start point, once the stream has ended (B-3). */
  start(): { lsn: string; timeline: number; startWal: string };
}

export interface BackupDeps {
  lockRegistry(holder: string): { release(): void };
  lockLedger(holder: string): Promise<{ release(): void }>;
  publicKey(): KeyObject | null;
  destination(): string;
  prepareDestination(path: string): void;
  /** The ledger's configured destinations (read-only), or why they can't be read. */
  ledgerDestinations(): { ok: true; paths: readonly string[] } | { ok: false; problems: readonly string[] };
  externalRule(destination: string, ledgerDestinations: readonly string[]): string | null;
  shipWal(destination: string, key: KeyObject): Promise<ShipResult>;
  baseBackup(): BaseBackup;
  vaultSnapshot(): AsyncIterable<Buffer>;
  cleanFiles(): AsyncIterable<TarEntry>;
  stackParts(): TarEntry[];
  facts(): Promise<Record<string, unknown>>;
  /** Called under the ledger lock. */
  snapshotLedger(): { ok: true; snapshot: LedgerSnapshot; entries: TarEntry[] } | { ok: false; problems: readonly string[] };
  deployed(): Readonly<Record<string, string>>;
  versions(): Readonly<Record<string, string>>;
  prune(destination: string, now: Date): string[];
  now(): Date;
  log(line: string): void;
  readonly fs?: SetFs;
}

export interface BackupResult {
  readonly ok: boolean;
  readonly setId?: string;
  readonly lines: string[];
}

/** A size the owner can read at any scale: a few-KB Vault snapshot showed as "0.0 MB", like an empty one. */
export const size = (n: number) => (n < 1024 ? `${String(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export async function takeBackup(deps: BackupDeps): Promise<BackupResult> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.log(l);
  };
  const lock = deps.lockRegistry('backup');
  try {
    const key = deps.publicKey();
    if (!key) return { ok: false, lines: ['no backup public key (infra/backup/backup.pub): run `pnpm stack:backup keygen --out <offline path>` and commit the public key'] };
    const destination = deps.destination();
    const ledger = deps.ledgerDestinations();
    if (!ledger.ok) return { ok: false, lines: ["the shred ledger's destinations can't be read, so no set is taken (spec 0020 D8):", ...ledger.problems] };
    const rule = deps.externalRule(destination, ledger.paths);
    if (rule) return { ok: false, lines: [rule] };
    deps.prepareDestination(destination);

    const shipped = await deps.shipWal(destination, key);
    for (const l of shipped.lines) say(l);

    const started = deps.now();
    const set = new SetWriter(destination, newSetId(started), key, deps.fs ?? realSetFs);
    const done = (r: ArtifactRecord) => say(`${r.name}: ${size(r.plainSize)} sealed`);
    const base = deps.baseBackup();
    done(await set.add('postgres.tar', base.stream));
    const start = base.start();
    done(await set.add('vault.snap', deps.vaultSnapshot()));
    done(await set.add('files.tar', tarStream(deps.cleanFiles())));
    done(await set.add('stack.tar', tarStream(deps.stackParts())));
    const facts = await deps.facts();

    let snapshot: LedgerSnapshot;
    const ledgerLock = await deps.lockLedger('backup');
    try {
      const s = deps.snapshotLedger();
      if (!s.ok) return { ok: false, lines: [...lines, ...s.problems] };
      snapshot = s.snapshot;
      done(await set.add('ledger.tar', tarStream(s.entries)));
    } finally {
      ledgerLock.release();
    }

    const index: SetIndex = await set.complete(
      {
        format: 'univarse-backup-manifest-v1',
        createdAt: started.toISOString(),
        versions: deps.versions(),
        deployed: deps.deployed(),
        postgres: { startLsn: start.lsn, timeline: start.timeline, startWal: start.startWal },
        // D12: the audit chains' checkpoint and the row counts, and (B-7) the WAL position a rehearsal restores to.
        facts,
        ledger: snapshot,
      },
      { createdAt: started, startWal: start.startWal, timeline: start.timeline },
    );
    const seconds = Math.round((deps.now().getTime() - started.getTime()) / 1000);
    say(`set ${index.setId} complete in ${String(seconds)} s (${String(index.files.length)} sealed files; WAL from ${start.startWal}; ledger at seq ${String(snapshot.seq)})`);
    for (const l of deps.prune(destination, deps.now())) say(l);
    return { ok: true, setId: index.setId, lines };
  } catch (e) {
    return { ok: false, lines: [...lines, `the backup stopped: ${(e as Error).message}. The set is incomplete (no index), so it is ignored and pruned later.`] };
  } finally {
    lock.release();
  }
}
