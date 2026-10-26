// Spec 0020 B2-5 to B2-10: the restore's real steps (engine.ts orders them and owns the stops and the teardown).
// Secrets come only from the set's own `stack.tar`, live only in a temporary owner-only directory and in memory, and
// reach containers through env files and `-e NAME`; nothing here prints one. Artifact data and WAL go from the sealed
// files, through memory, into the restore's Docker volumes: never in clear on the host's disk (B2-6).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, type KeyObject } from 'node:crypto';
import { restrictDirToOwner, writeOwnerOnly } from '../../../../packages/db/scripts/pgbouncer-config.js';
import { loadSettings, PUBLIC_KEY_FILE } from '../backup/config.js';
import { loadPrivateKey, loadPublicKey } from '../backup/seal.js';
import { WAL } from '../backup/set.js';
import { realWalDeps, shipWal } from '../backup/wal.js';
import { RELEASES, STACK_DIR, THIRD_PARTY } from '../config.js';
import { imagesFrom } from '../deploy.js';
import { registry } from '../deploy-deps.js';
import { docker, hostPath } from '../docker.js';
import { PRIMARY, LEDGER_DIR } from '../keys.js';
import { establishAuthority } from '../ledger/ledger.js';
import { keysDbFrom } from '../ledger/job.js';
import { acquireLedgerLock } from '../ledger/lock.js';
import { recover as recoverLedger } from '../ledger/protocol.js';
import { acquireRegistryLock, verifyRelease, type ReleaseRecord } from '../release.js';
import { envText, renderEnvFiles, renderPgBouncerIni, renderPgHba, renderS3Config, renderUserlist, renderValkeyConf } from '../render.js';
import { loadSecrets } from '../secrets.js';
import { BUCKETS } from '../deploy-deps.js';
import { configure as configureVault, loadVaultInit, renewTokens, tokensOf, type VaultTarget } from '../vault.js';
import { fillScript } from '../volumes.js';
import { openSet, type OpenedSet } from './artifact.js';
import type { Facts } from './checks.js';
import type { Job, RestoreDeps, RestoreRequest } from './engine.js';
import { sampleMemory } from './memory.js';
import { recovered, restoreFilesThrough, restoreSnapshot, targetSetting, unpackBase, unpackWal, walEntries } from './steps.js';
import { copyToScratch, realHeads, remappedFs } from './scratch-ledger.js';
import {
  APP_NETWORK,
  compose,
  CONFIG_VOLUMES,
  DATA_OWNERS,
  jobRunner,
  labelledVolume,
  POSTGRES,
  REHEARSAL_DATA,
  removeLabelled,
  SEAWEEDFS,
  VAULT,
  WAL_VOLUME,
  type ComposeEnv,
  type DataVolumes,
} from './target.js';

/** The set's own parts the restore needs from `stack.tar` (D2). */
const PARTS = ['secrets.json', 'vault-init.json'];
const RESTORE_VAULT: VaultTarget = { container: VAULT, tls: true };

export interface RealOptions {
  readonly keyFile: string;
  readonly passphrase: string;
  readonly log: (line: string) => void;
  /** A real restore's own preparation (B2-12); a rehearsal's is its leftovers removed and its volumes created. */
  readonly prepare?: (set: OpenedSet, data: DataVolumes) => Promise<readonly string[]>;
  readonly data?: DataVolumes;
}

const lastJson = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    return null;
  }
};
const tail = (s: string) => s.trim().split('\n').slice(-4).join(' | ').slice(0, 400);

export function realRestoreDeps(req: RestoreRequest, opts: RealOptions): RestoreDeps {
  const data = opts.data ?? REHEARSAL_DATA;
  const rehearsal = req.mode === 'rehearsal';
  // B2-6 step 4: owner-only, beside the stack directory, removed in the teardown. Never inside the repository.
  const dir = join(homedir(), '.univarse', `restore-${randomBytes(4).toString('hex')}`);
  const scratch = join(dir, 'ledger');
  let images: Readonly<Record<string, string>> = {};
  let stopRegistry: () => void = () => undefined;
  let target = 'recovery_target_action=promote';
  const env = (): ComposeEnv => ({ dir, data, images, target });
  const destination = () => loadSettings().destination;
  const keys = () => jobRunner('keys', env(), ['--enable-source-maps', 'dist/cli/keys.js']);
  const keysJob = <T>(args: readonly string[], input?: string): Job<T> => {
    const r = keys()(args, input === undefined ? {} : { input });
    const value = lastJson(r.stdout) as T | null;
    return { ok: r.status === 0 && value !== null, ...(value === null ? {} : { value }), lines: r.status === 0 ? [] : [`the keys job's ${args[0] ?? ''} exited ${String(r.status)}: ${tail(r.stderr)}`] };
  };
  const psql = (sql: string) => {
    const s = loadSecrets(dir);
    return docker(['exec', '-e', 'PGPASSWORD', '-u', 'postgres', POSTGRES, 'psql', '-qAt', '-d', 'postgres', '-c', sql], { env: { PGPASSWORD: s.postgresSuperuser }, allowFail: true });
  };
  const walDir = (timeline: number) => join(destination(), WAL, timeline.toString(16).toUpperCase().padStart(8, '0'));

  return {
    log: opts.log,
    now: () => new Date(),
    openKey: (): KeyObject => loadPrivateKey(JSON.parse(readFileSync(opts.keyFile, 'utf8')) as Parameters<typeof loadPrivateKey>[0], opts.passphrase),
    openSet: (setId, key) => openSet(destination(), setId, key),
    prepareTarget: async (set) => {
      // A crashed run's leftovers, found by their label; then this run's volumes, labelled.
      const lines = removeLabelled();
      for (const l of lines) opts.log(l);
      if (opts.prepare) {
        const p = await opts.prepare(set, data);
        if (p.length) return p;
      }
      mkdirSync(dir, { recursive: true });
      restrictDirToOwner(dir);
      for (const [v, owner] of Object.entries(DATA_OWNERS(data))) labelledVolume(v, owner);
      for (const v of Object.keys(CONFIG_VOLUMES)) labelledVolume(v, '0:0');
      return [];
    },
    realHeads: () => realHeads(PRIMARY),
    lockRegistry: (holder) => acquireRegistryLock(RELEASES, holder),
    verifyRelease: (deployed) => {
      // The record whose digests are the ones the set ran: matched per role by digest, then verified with its own commit.
      const digest = (ref: string | undefined) => ref?.split('@')[1] ?? '';
      const records = readdirSync(RELEASES).filter((f) => /^\d{4}-\d{2}-\d{2}-[0-9a-f]{7,}\.json$/.test(f));
      const match = records.find((f) => {
        const r = JSON.parse(readFileSync(join(RELEASES, f), 'utf8')) as Partial<ReleaseRecord>;
        const want = Object.values(deployed).map(digest).filter(Boolean).sort();
        const have = Object.values(r.images ?? {}).map((i) => i.digest).sort();
        return want.length > 0 && want.every((d) => have.includes(d));
      });
      if (!match) return { ok: false, problems: [`no release record in releases/ names the images this set ran (${Object.keys(deployed).join(', ')}): \`images:prune\` may have removed it`] };
      const record = JSON.parse(readFileSync(join(RELEASES, match), 'utf8')) as ReleaseRecord;
      stopRegistry = registry();
      const v = verifyRelease(record, { commit: record.commit });
      if (!v.ok) return { ok: false, problems: [`release ${match} does not verify:`, ...v.problems, 'an image that is no longer in the registry was probably pruned (`images:prune`)'] };
      const got = imagesFrom(v);
      if (got.problems.length) return { ok: false, problems: got.problems };
      images = got.images;
      return { ok: true, images, record: `releases/${match}` };
    },
    configure: async (set) => {
      const parts = await set.files('stack.tar');
      for (const name of PARTS) if (!parts.some((p) => p.name === name)) return [`set ${set.index.setId} has no ${name} in its stack.tar`];
      for (const p of parts) {
        if (!/^[a-z0-9_./-]+$/.test(p.name) || p.name.includes('..')) return [`set ${set.index.setId}: an unexpected part ${p.name}`];
        // Every part is text: JSON, PEM certificates and keys.
        writeOwnerOnly(join(dir, ...p.name.split('/')), p.data.toString('utf8'));
      }
      const problem = renderAll(dir);
      if (problem) return [problem];
      fillConfig(dir);
      return [];
    },
    shippedWal: (timeline) => {
      try {
        return readdirSync(walDir(timeline)).filter((f) => f.endsWith('.gz.seal')).map((f) => f.slice(0, -'.gz.seal'.length));
      } catch {
        return [];
      }
    },
    shipWal: async () => {
      // The caller holds the registry lock, so the shipper is called directly (B2-7), as the backup calls it.
      // Shipping needs only the staging volume, not a running stack: a real restore ships what was staged too.
      return (await shipWal(destination(), loadPublicKey(readFileSync(PUBLIC_KEY_FILE, 'utf8')), realWalDeps())).lines;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newestShippedAt: (timeline) => {
      try {
        const f = readdirSync(walDir(timeline)).filter((n) => /^[0-9A-F]{24}\.gz\.seal$/.test(n)).sort().at(-1);
        return f ? statSync(join(walDir(timeline), f)).mtime : null;
      } catch {
        return null;
      }
    },
    restorePostgres: async (set, wal, rt) => {
      const base = await unpackBase(data.pgdata, set.artifact('postgres.tar'));
      if (base.length) return base;
      const key = loadPrivateKey(JSON.parse(readFileSync(opts.keyFile, 'utf8')) as Parameters<typeof loadPrivateKey>[0], opts.passphrase);
      const w = await unpackWal(WAL_VOLUME, walEntries(walDir(set.manifest.postgres.timeline), wal, key));
      if (w.length) return w;
      target = targetSetting(rt);
      const up = compose(['up', '-d', '--wait', 'postgres'], env());
      const logs = docker(['logs', '--tail', '40', POSTGRES], { allowFail: true });
      return recovered(rt, up.status === 0, logs.stderr + logs.stdout, (sql) => psql(sql).stdout.trim(), wal.at(-1));
    },
    restoreVault: async (set) => {
      if (compose(['up', '-d', '--wait', 'vault'], env()).status !== 0) return ['the restore\'s Vault did not start'];
      return restoreSnapshot(RESTORE_VAULT, set.artifact('vault.snap'), dir);
    },
    vaultTokens: () => {
      // Spec 0023 T4 on the restored Vault: a token past its period is re-issued with the set's root token.
      const c = configureVault(docker, dir, RESTORE_VAULT);
      const renewed = renewTokens(docker, dir, RESTORE_VAULT);
      const problem = renderAll(dir);
      if (problem) return { ok: false, lines: [problem] };
      fillConfig(dir);
      return { ok: renewed.ok, lines: [...c.reissued.map((n) => `the ${n} token was invalid or expired in the set: re-issued`), ...renewed.lines] };
    },
    restoreFiles: async (set) => {
      if (compose(['up', '-d', '--wait', 'seaweedfs'], env()).status !== 0) return { objects: 0, problems: ['the restore\'s SeaweedFS did not start'] };
      const bucketProblem = createBuckets();
      if (bucketProblem) return { objects: 0, problems: [bucketProblem] };
      const s = loadSecrets(dir);
      return restoreFilesThrough(APP_NETWORK, set.artifact('files.tar'), { accessKey: s.s3AccessKey, secretKey: s.s3SecretKey });
    },
    start: (services) => (compose(['up', '-d', '--wait', ...services], env()).status === 0 ? [] : [`${services.join(', ')} did not start healthy`]),
    migrateCheck: () => {
      const r = jobRunner('migrate', env(), ['--enable-source-maps', 'dist/main.js', '--check-only'])([]);
      return { ok: r.status === 0, lines: r.status === 0 ? [] : [tail(r.stdout + r.stderr)] };
    },
    facts: () => keysJob<Facts>(['backup-facts']),
    verifyChains: (checkpoint) => keysJob(checkpoint ? ['verify-chains', '--checkpoint-stdin'] : ['verify-chains'], checkpoint ? JSON.stringify(checkpoint) : undefined),
    verifyUnwrap: () => keysJob(['verify-unwrap']),
    verifyDecrypt: () => keysJob(['verify-decrypt']),
    recover: async () => {
      const base = keysDbFrom(keys());
      // D7's bucket copy is evidence only, and the restore's SeaweedFS has no ledger bucket (D2): never written here.
      const db = { ...base, copyToBucket: () => Promise.resolve(null) };
      if (rehearsal) {
        // B2-10: the real destinations copied under the ledger lock, briefly; recovery then runs on the copies only.
        const lock = await acquireLedgerLock(LEDGER_DIR, 'restore rehearsal', { waitMs: 10 * 60_000 });
        let copied: ReturnType<typeof copyToScratch>;
        try {
          copied = copyToScratch(PRIMARY, scratch);
        } finally {
          lock.release();
        }
        if (!copied.ok) return { ok: false, lines: copied.problems, entries: [] };
        const fs = remappedFs(copied.map);
        const r = await recoverLedger({ primary: PRIMARY, db, fs, lock: () => Promise.resolve({ release: () => undefined }), log: opts.log }, 'restore rehearsal');
        const a = establishAuthority(PRIMARY, fs);
        return { ok: r.ok, lines: r.lines, entries: a.ok ? a.entries : [] };
      }
      const r = await recoverLedger({ primary: PRIMARY, db, lock: (h) => acquireLedgerLock(LEDGER_DIR, h, { waitMs: 10 * 60_000 }), log: opts.log }, 'restore');
      const a = establishAuthority(PRIMARY);
      return { ok: r.ok, lines: r.lines, entries: a.ok ? a.entries : [] };
    },
    teardown: () => {
      const lines: string[] = [];
      compose(['down', '--remove-orphans'], env());
      try {
        lines.push(...removeLabelled());
      } catch (e) {
        lines.push(`WARN teardown: ${(e as Error).message}: remove them with \`docker volume ls --filter label=univarse.restore\``);
      }
      // A real restore keeps the restored Vault's tokens (re-issued ones included) for the deploy that follows.
      if (!rehearsal) {
        try {
          writeOwnerOnly(join(STACK_DIR, 'vault-init.json'), readFileSync(join(dir, 'vault-init.json'), 'utf8'));
        } catch (e) {
          lines.push(`WARN the restored Vault's tokens were not kept (${(e as Error).message}): the next deploy re-issues them`);
        }
      }
      rmSync(dir, { recursive: true, force: true });
      stopRegistry();
      lines.push(rehearsal ? 'torn down: the restore project, its volumes, its configuration and its scratch ledger are removed' : 'the restore project is stopped; the stack\'s data volumes hold the restored set');
      return lines;
    },
    memory: () => sampleMemory(),
  };
}

/** The env files (with Vault's tokens once they're good) and the rendered configuration, in the restore's directory. */
function renderAll(dir: string): string | null {
  try {
    const s = loadSecrets(dir);
    // vault-init.json's tokens: the set's own until the restored Vault has made them good (vaultTokens re-renders).
    for (const [name, file] of Object.entries(renderEnvFiles(s, tokensOf(loadVaultInit(dir))))) writeOwnerOnly(join(dir, name), envText(file));
    const rendered = join(dir, 'rendered');
    mkdirSync(rendered, { recursive: true });
    const files: Record<string, string> = { 'pg_hba.conf': renderPgHba(), 'pgbouncer.ini': renderPgBouncerIni(), 'userlist.txt': renderUserlist(s), 'valkey.conf': renderValkeyConf(s), 's3.json': renderS3Config(s) };
    for (const [name, text] of Object.entries(files)) writeOwnerOnly(join(rendered, name), text);
    return null;
  } catch (e) {
    return `the set's configuration could not be rendered: ${(e as Error).message}`;
  }
}

/** Each configuration volume refilled from the restore's directory, as the deploy fills the stack's. */
function fillConfig(dir: string): void {
  for (const [volume, files] of Object.entries(CONFIG_VOLUMES))
    docker(['run', '--rm', '--network', 'none', '--label', 'univarse.restore=1', '--user', '0:0', '--entrypoint', 'sh', '-v', `${hostPath(dir)}:/src:ro`, '-v', `${volume}:/dst`, THIRD_PARTY.postgres, '-c', fillScript(files)]);
}

/** The clean and quarantine buckets (never the ledger's: D2 leaves it out of a set, B2-10), as the deploy creates them. */
function createBuckets(): string | null {
  const shell = (commands: string) => docker(['exec', '-i', '-e', 'HOME=/tmp', SEAWEEDFS, '/usr/bin/weed', 'shell', '-master=127.0.0.1:9333', '-filer=127.0.0.1:8888'], { input: `${commands}\n`, allowFail: true });
  const wanted = Object.keys(BUCKETS).filter((b) => b !== 'uv-shred-ledger');
  for (let i = 0; i < 20; i++) {
    const have = new Set([...shell('s3.bucket.list').stdout.matchAll(/^\s*([a-z0-9-]{3,63})\s/gm)].map((m) => m[1]));
    const missing = wanted.filter((b) => !have.has(b));
    if (!missing.length) return null;
    shell(missing.map((b) => `s3.bucket.create -name ${b}`).join('\n'));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  return 'the restore\'s buckets were not created (SeaweedFS)';
}
