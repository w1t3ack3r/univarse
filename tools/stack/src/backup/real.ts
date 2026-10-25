// Spec 0020 PR B1: the backup's real steps (backup.ts orders them). Secrets reach containers only through env files
// and `-e NAME`; nothing here prints one, and every artifact is sealed before it touches the disk.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { restrictDirToOwner } from '../../../../packages/db/scripts/pgbouncer-config.js';
import { edgeClient } from '../bucket-check.js';
import { COMPOSE_FILE, PROJECT, RELEASES, REPO, STACK_DIR, THIRD_PARTY } from '../config.js';
import { establishAuthority } from '../ledger/ledger.js';
import { composeRunner, deployedImages } from '../ledger/job.js';
import { acquireLedgerLock } from '../ledger/lock.js';
import { LEDGER_DIR, PRIMARY } from '../keys.js';
import { acquireRegistryLock } from '../release.js';
import { loadSecrets } from '../secrets.js';
import { cliEnv, loadVaultInit, renewBeforeSnapshot, STACK_VAULT, VAULT_CONTAINER } from '../vault.js';
import type { BackupDeps } from './backup.js';
import { DEFAULT_DESTINATION, loadSettings, PUBLIC_KEY_FILE, within } from './config.js';
import { externalRuleProblem } from './external.js';
import { snapshotLedger } from './ledger-snapshot.js';
import { BASEBACKUP_ARGS, startOf } from './pgbase.js';
import { prune } from './prune.js';
import { loadPublicKey } from './seal.js';
import { docker } from '../docker.js';
import { dockerStream } from './stream.js';
import type { TarEntry } from './tar.js';
import { realWalDeps, shipWal } from './wal.js';

/** D2: what a restore needs from the stack directory. Not the rendered files (the deploy re-renders them). */
const STACK_PARTS = ['secrets.json', 'vault-init.json', 'certs', 'edge'];
const CLEAN_BUCKET = 'uv-clean';
/** A backup during a destruction waits for it, as a deploy does (a destroy holds the ledger lock a minute or two). */
const LEDGER_WAIT_MS = 10 * 60_000;

/** A file, or every file under a directory, named relative to `root`; nothing when it doesn't exist. */
function readTree(root: string, path: string): TarEntry[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [{ name: relative(root, path).split('\\').join('/'), data: readFileSync(path) }];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() || e.isFile() ? readTree(root, join(path, e.name)) : []));
}

export function realBackupDeps(): BackupDeps {
  const images = () => deployedImages();
  return {
    lockRegistry: (holder) => acquireRegistryLock(RELEASES, holder),
    lockLedger: (holder) => acquireLedgerLock(LEDGER_DIR, holder, { waitMs: LEDGER_WAIT_MS }),
    publicKey: () => (existsSync(PUBLIC_KEY_FILE) ? loadPublicKey(readFileSync(PUBLIC_KEY_FILE, 'utf8')) : null),
    destination: () => loadSettings().destination,
    prepareDestination: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      // D6: the default is owner-only. A path the owner chose (an external drive) keeps its own permissions: the sets
      // are sealed either way.
      if (within(path, DEFAULT_DESTINATION) && within(DEFAULT_DESTINATION, path)) restrictDirToOwner(path);
    },
    ledgerDestinations: () => {
      const a = establishAuthority(PRIMARY);
      return a.ok ? { ok: true, paths: a.destinations.map((d) => d.path) } : { ok: false, problems: a.problems };
    },
    externalRule: (destination, paths) => externalRuleProblem(destination, PRIMARY.path, paths),
    shipWal: (destination, key) => shipWal(destination, key, realWalDeps()),
    baseBackup: () => {
      let stderr = '';
      const stream = dockerStream(['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'run', '--rm', '-T', 'pgbackup', ...BASEBACKUP_ARGS], {
        env: { UNIVARSE_STACK_DIR: STACK_DIR, ...images() },
        onStderr: (t) => {
          stderr += t;
        },
      });
      return { stream, start: () => startOf(stderr) };
    },
    vaultSnapshot: () => {
      const { backupToken } = loadVaultInit();
      if (!backupToken) throw new Error('Vault has no backup token yet: deploy this release once (its Vault setup creates it)');
      // Spec 0023: the token renews itself first, so a daily backup keeps it alive on its own.
      const stop = renewBeforeSnapshot(docker, backupToken);
      if (stop) throw new Error(stop);
      // The token by name only (-e VAULT_TOKEN); the snapshot straight to stdout, never a file in the container.
      return dockerStream(['exec', ...cliEnv(STACK_VAULT), '-e', 'VAULT_TOKEN', VAULT_CONTAINER, 'vault', 'operator', 'raft', 'snapshot', 'save', '/dev/stdout'], { env: { VAULT_TOKEN: backupToken } });
    },
    cleanFiles: () => ({
      async *[Symbol.asyncIterator]() {
        const s = loadSecrets();
        const client = edgeClient(s.s3AccessKey, s.s3SecretKey);
        try {
          let token: string | undefined;
          do {
            const page = await client.send(new ListObjectsV2Command({ Bucket: CLEAN_BUCKET, ContinuationToken: token }));
            for (const o of page.Contents ?? []) {
              if (!o.Key) continue;
              const got = await client.send(new GetObjectCommand({ Bucket: CLEAN_BUCKET, Key: o.Key }));
              yield { name: o.Key, data: Buffer.from((await got.Body?.transformToByteArray()) ?? []) };
            }
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
          } while (token);
        } finally {
          client.destroy();
        }
      },
    }),
    stackParts: () => STACK_PARTS.flatMap((p) => readTree(STACK_DIR, join(STACK_DIR, p))),
    facts: () => {
      const r = composeRunner(images())(['backup-facts']);
      if (r.status !== 0) return Promise.reject(new Error(`the keys job's backup-facts exited ${String(r.status)}`));
      return Promise.resolve(JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>);
    },
    snapshotLedger: () => snapshotLedger(PRIMARY),
    deployed: images,
    versions: () => ({
      postgres: THIRD_PARTY.postgres,
      vault: THIRD_PARTY.vault,
      seaweedfs: THIRD_PARTY.seaweedfs,
      tools: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim(),
    }),
    prune: (destination, now) => prune(destination, now),
    now: () => new Date(),
    log: (l) => {
      console.log(`[stack:backup] ${l}`);
    },
  };
}
