// Spec 0019 LS3 (spec 0013 LR9, transferred; blocking): the only way the stack starts.
//   pnpm stack:deploy <releases/record.json> [--commit <sha>]
//   1. the registry lock (spec 0013 LR8), held until the stack is up or the deploy has failed;
//   2. verifyRelease on the record: every role in ROLES, their Dockerfiles from trusted code, the commit from the
//      deployment target (--commit, else the checkout's HEAD; never the record's), never a rehearsal. A rejected
//      record stops here: nothing has been created, written or started;
//   3. only then: secrets rendered, volumes filled, Vault, the migrate job, the buckets, the shred ledger's recovery
//      (spec 0020 D8: before the API and worker start), the stack, the smoke check.
// Every side effect is a step in `DeployDeps`, so the tests show that nothing runs before verification passes.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDigestRef, RELEASES, REPO, ROLE_VARS, type Role } from './config.js';
import { hostRef, RELEASE_ROLES, type ReleaseRecord, type Verification } from './release.js';
import { storageProblem, type VaultStorage } from './vault-raft.js';

export type VaultState = 'absent' | 'uninitialised' | 'sealed' | 'ready';

export interface DeployDeps {
  /** The local registry, for verification and pulls: started if needed; the returned function stops what it started. */
  registry(): () => void;
  lock(holder: string): { release(): void };
  verify(record: ReleaseRecord, opts: { commit: string }): Verification;
  /**
   * Renders the env files and configuration (with Vault's app token once it exists) and fills the volumes whose content
   * changed. Returns the services reading a changed volume: they must restart to load it.
   */
  prepare(withVault: boolean): string[];
  /**
   * Records that the restarted services have loaded their volumes' content (prepare stops naming them): all of them,
   * or only the volumes read by `services` alone.
   */
  markApplied(services?: readonly string[]): void;
  /** D8: scans the third-party images and returns report lines; never blocks. */
  scanThirdParty(): string[];
  compose(args: readonly string[], images: Readonly<Record<string, string>>): { status: number };
  vaultState(): VaultState;
  /**
   * Spec 0020 D4, B-4: what Vault's two storage volumes hold. The deploy proceeds only on `raft` or `fresh`, so it never
   * starts Vault on a half-migrated Raft volume, nor initialises a second Vault beside the one in file storage.
   */
  vaultStorage(): VaultStorage;
  /** Initialises Vault on first use, otherwise completes any missing part of its setup (idempotent). */
  ensureVault(): void;
  /** The storage buckets, created if missing (idempotent); returns problems. SeaweedFS must be running. */
  buckets(): string[];
  /**
   * Spec 0020 D8 (A2-11): the ledger's recovery, under the ledger lock (taken after the registry lock), with the keys
   * job from the images being deployed. With `initLedger`, the owner's one-time init runs first (A2-3).
   */
  recover(images: Readonly<Record<string, string>>, opts: { initLedger: boolean }): Promise<{ ok: boolean; lines: readonly string[] }>;
  smoke(): Promise<string[]>;
  logs(): string;
  saveState(images: Readonly<Record<string, string>>): void;
  /**
   * Spec 0020 D6, B2-3: `stack:backup status`'s warnings (the newest set's age, staged WAL, the schedule), printed at
   * the end of a deploy that passed. They never block it, and a backup state that can't be read is one more warning.
   */
  backupWarnings(): string[];
  log(line: string): void;
}

/** The long-running services, in the order compose may start them (it resolves dependencies itself). */
export const SERVICES = ['postgres', 'pgbouncer', 'valkey', 'seaweedfs', 'mailpit', 'vault', 'api', 'worker', 'web', 'caddy'] as const;

/** LS2: the compose variables from the verified results, each a digest reference the host's Docker can pull. */
export function imagesFrom(v: Verification): { images: Record<string, string>; problems: string[] } {
  const images: Record<string, string> = {};
  const problems: string[] = [];
  for (const role of RELEASE_ROLES) {
    const ref = v.results[role];
    const name = ROLE_VARS[role as Role] as string | undefined;
    if (!name) problems.push(`no compose variable for the ${role} role`);
    else if (!ref) problems.push(`${role} did not verify`);
    else {
      const host = hostRef(ref);
      if (!isDigestRef(host)) problems.push(`${role}: ${host} is not pinned by digest`);
      else images[name] = host;
    }
  }
  return { images, problems };
}

export async function deploy(record: ReleaseRecord, commit: string, deps: DeployDeps, opts: { initLedger?: boolean } = {}): Promise<{ ok: boolean; problems: string[] }> {
  const lock = deps.lock('deploy');
  let stopRegistry = () => undefined as unknown;
  try {
    // Inside the try: whatever fails from here, the lock is released (LS3).
    stopRegistry = deps.registry();
    // ── LS3 (2): verification first. A rejection returns before any other step runs.
    const v = deps.verify(record, { commit });
    if (!v.ok) return { ok: false, problems: v.problems };
    const { images, problems } = imagesFrom(v);
    if (problems.length) return { ok: false, problems };
    deps.log(`[stack:deploy] verified ${Object.keys(images).length} images for ${commit.slice(0, 7)}: ${Object.values(images).join(', ')}`);

    // ── Configuration, then Vault (it holds the KEK the migrate job and the API need).
    const restart = new Set(deps.prepare(false));
    for (const line of deps.scanThirdParty()) deps.log(line);
    const vaultStorage = storageProblem(deps.vaultStorage());
    if (vaultStorage) return { ok: false, problems: [vaultStorage] };
    if (deps.compose(['up', '-d', '--wait', 'vault'], images).status !== 0) return { ok: false, problems: ['Vault did not start'] };
    // A changed certificate (C2) loads only at start, and a restarted Vault is sealed: restart it now, record it at
    // once (so the next deploy doesn't restart it again), and let the sealed state below ask for the owner's unseal.
    if (restart.has('vault')) {
      deps.log('[stack:deploy] restarting vault: its certificate changed (it comes back sealed)');
      if (deps.compose(['restart', 'vault'], images).status !== 0 || deps.compose(['up', '-d', '--wait', 'vault'], images).status !== 0)
        return { ok: false, problems: ['Vault did not restart'] };
      deps.markApplied(['vault']);
      restart.delete('vault');
    }
    const vault = deps.vaultState();
    if (vault === 'sealed') return { ok: false, problems: ['Vault is sealed: run `pnpm stack:vault unseal`, then deploy again (spec 0019 D9)'] };
    if (vault === 'absent') return { ok: false, problems: ['Vault is not reachable'] };
    if (vault === 'uninitialised') deps.log('[stack:deploy] first deploy: initialising Vault (its keys are saved owner-only in the stack directory)');
    deps.ensureVault();
    for (const s of deps.prepare(true)) restart.add(s);

    // ── LS4: the database, then the migrate job, before the API, worker and web; a failed job starts nothing new.
    if (deps.compose(['up', '-d', '--wait', 'postgres'], images).status !== 0) return { ok: false, problems: ['PostgreSQL did not become healthy'] };
    // A running PostgreSQL keeps its old certificate until restarted (a reissued stack CA would fail PgBouncer's check).
    if (restart.has('postgres')) {
      deps.log('[stack:deploy] restarting postgres: its certificate or configuration changed');
      if (deps.compose(['restart', 'postgres'], images).status !== 0 || deps.compose(['up', '-d', '--wait', 'postgres'], images).status !== 0)
        return { ok: false, problems: ['PostgreSQL did not restart healthy'] };
    }
    if (deps.compose(['--profile', 'job', 'run', '--rm', 'migrate'], images).status !== 0)
      return { ok: false, problems: ['the migrate job failed: nothing new was started (its output is above)'] };

    // ── Storage: the buckets exist before the API and worker use them.
    if (deps.compose(['up', '-d', '--wait', 'seaweedfs'], images).status !== 0) return { ok: false, problems: ['SeaweedFS did not start'] };
    // SeaweedFS reads its identities (s3.json) only at start, and the ledger's recovery below writes the bucket copy
    // with one of them: restart it now when they changed, and record it, so it isn't restarted again at the end.
    if (restart.has('seaweedfs')) {
      deps.log('[stack:deploy] restarting seaweedfs before the buckets and the ledger\'s recovery: its identities changed');
      if (deps.compose(['restart', 'seaweedfs'], images).status !== 0 || deps.compose(['up', '-d', '--wait', 'seaweedfs'], images).status !== 0)
        return { ok: false, problems: ['SeaweedFS did not restart'] };
      deps.markApplied(['seaweedfs']);
      restart.delete('seaweedfs');
    }
    const storage = deps.buckets();
    if (storage.length) return { ok: false, problems: storage };

    // ── Spec 0020 D8: the keys job reaches the databases through PgBouncer, so it (and Valkey, for the forget notice)
    // runs first, on its current configuration; then recovery. A destroyed tenant's keys are destroyed again, or the
    // deploy stops, before anything that could decrypt starts.
    if (deps.compose(['up', '-d', '--wait', 'pgbouncer', 'valkey'], images).status !== 0) return { ok: false, problems: ['PgBouncer or Valkey did not start'] };
    const early = ['pgbouncer', 'valkey'].filter((s) => restart.has(s));
    if (early.length) {
      deps.log(`[stack:deploy] restarting ${early.join(', ')} before the ledger's recovery: their configuration changed`);
      if (deps.compose(['restart', ...early], images).status !== 0 || deps.compose(['up', '-d', '--wait', ...early], images).status !== 0)
        return { ok: false, problems: [`${early.join(', ')} did not restart healthy`] };
      deps.markApplied(early);
      for (const s of early) restart.delete(s);
    }
    const recovered = await deps.recover(images, { initLedger: opts.initLedger ?? false });
    for (const line of recovered.lines) deps.log(`[stack:deploy] ledger: ${line}`);
    if (!recovered.ok) return { ok: false, problems: ["the shred ledger's recovery stopped the deploy before the API and worker started (spec 0020 D8); see the ledger lines above"] };

    // ── The stack. Containers whose image changed are replaced; the rest stay.
    if (deps.compose(['up', '-d', '--wait', '--remove-orphans', ...SERVICES], images).status !== 0)
      return { ok: false, problems: ['the stack did not start (see `docker compose -p univarse-stack ps`)'] };
    // Services reading a changed volume (a rotated password or certificate) load it only at start.
    const others = [...restart].filter((s) => s !== 'postgres').sort();
    if (others.length) {
      deps.log(`[stack:deploy] restarting ${others.join(', ')}: their certificates or configuration changed`);
      if (deps.compose(['restart', ...others], images).status !== 0 || deps.compose(['up', '-d', '--wait', ...SERVICES], images).status !== 0)
        return { ok: false, problems: [`${others.join(', ')} did not restart healthy`] };
    }
    deps.markApplied();

    // ── LS6: the smoke check.
    const smoke = await deps.smoke();
    if (smoke.length) {
      deps.log(deps.logs());
      return { ok: false, problems: smoke };
    }
    deps.saveState(images);
    for (const w of deps.backupWarnings()) deps.log(`[stack:deploy] WARN backup: ${w}`);
    return { ok: true, problems: [] };
  } finally {
    stopRegistry();
    lock.release(); // ── LS3 (1): held to here, success or failure
  }
}

export { nextState } from './state.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { realDeps } = await import('./deploy-deps.js');
  const [arg0, ...rest] = process.argv.slice(2);
  // pnpm runs this from tools/stack; the record path is relative to where the owner typed the command.
  const file = arg0 ? resolve(process.env.INIT_CWD ?? process.cwd(), arg0) : undefined;
  const arg = (n: string) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  if (!file || !existsSync(file)) {
    console.error('usage: pnpm stack:deploy <releases/record.json> [--commit <sha>] [--init-ledger]');
    process.exit(2);
  }
  const commit = arg('commit') ?? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const record = JSON.parse(readFileSync(file, 'utf8')) as ReleaseRecord;
  let result: { ok: boolean; problems: string[] };
  try {
    // --init-ledger: once, for a stack that has never had a shred ledger (spec 0020 A2-3); never implied.
    result = await deploy(record, commit, realDeps(), { initLedger: rest.includes('--init-ledger') });
  } catch (e) {
    result = { ok: false, problems: [(e as Error).message] };
  }
  if (!result.ok) {
    for (const p of result.problems) console.error(`[stack:deploy] REJECT ${p}`);
    process.exit(1);
  }
  console.log(`[stack:deploy] PASS: the stack runs ${commit.slice(0, 7)}'s verified images; state in ${join(RELEASES, 'deploy-state.json')}`);
}
