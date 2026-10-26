// Spec 0020 B2-6 steps 5 and 6: PostgreSQL's and Vault's restore, each on the volume or container it's given, so the
// rehearsal (real.ts) and CI's restore test (restore.int.ts, B2-13) run exactly the same steps.
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { unsealStream } from '../backup/seal.js';
import type { TarEntry } from '../backup/tar.js';
import { tarStream } from '../backup/tar.js';
import { THIRD_PARTY } from '../config.js';
import { docker, type Runner } from '../docker.js';
import { cliEnv, loadVaultInit, unseal, vaultCli, vaultState, type VaultTarget } from '../vault.js';
import type { RecoveryTarget } from './engine.js';
import { CONTAINER_SCRIPT, filesProblems, scratchTar } from './files.js';
import { FILES_SCRATCH, LABEL, pipeInto } from './target.js';

/** The pinned image's data directory (its PGDATA). */
export const PGDATA = '/var/lib/postgresql/18/docker';
const tail = (s: string) => s.trim().split('\n').slice(-4).join(' | ').slice(0, 400);

/** The base backup's tar, straight into the data volume as PostgreSQL's user, with recovery.signal beside it. */
export async function unpackBase(volume: string, tar: Readable): Promise<string[]> {
  const r = await pipeInto(
    ['run', '-i', '--rm', '--network', 'none', '--label', `${LABEL}=1`, '--user', '999:999', '-v', `${volume}:/var/lib/postgresql`, '--entrypoint', 'sh', THIRD_PARTY.postgres, '-c', `mkdir -p ${PGDATA} && chmod 0700 ${PGDATA} && tar -x -f - -C ${PGDATA} && touch ${PGDATA}/recovery.signal`],
    tar,
  );
  return r.status === 0 ? [] : [`the base backup did not unpack into ${volume}: ${tail(r.stderr)}`];
}

/** Shipped WAL files (`<dir>/<name>.gz.seal`), unsealed and decompressed in memory, one at a time. */
export async function* walEntries(dir: string, names: readonly string[], key: KeyObject): AsyncGenerator<TarEntry> {
  for (const name of names) {
    const parts: Buffer[] = [];
    for await (const b of Readable.from([readFileSync(join(dir, `${name}.gz.seal`))]).pipe(unsealStream(key)) as AsyncIterable<Buffer>) parts.push(b);
    yield { name, data: gunzipSync(Buffer.concat(parts)), mode: 0o600 };
  }
}

/** The WAL as a tar into its own volume, which PostgreSQL's restore_command reads (read-only). */
export async function unpackWal(volume: string, entries: AsyncIterable<TarEntry>): Promise<string[]> {
  const r = await pipeInto(['run', '-i', '--rm', '--network', 'none', '--label', `${LABEL}=1`, '--user', '999:999', '-v', `${volume}:/w`, '--entrypoint', 'tar', THIRD_PARTY.postgres, '-x', '-f', '-', '-C', '/w'], tarStream(entries));
  return r.status === 0 ? [] : [`the WAL did not unpack: ${tail(r.stderr)}`];
}

/**
 * The `-c` setting for the target, as restore.compose.yml takes it. A time is written with a numeric offset
 * (`2026-10-26 06:41:54.304+00`): PostgreSQL 18 checks this setting at start, before it loads the time-zone
 * abbreviations, and refuses ISO's `Z` as an invalid value (found by CI's restore test).
 */
export const targetSetting = (rt: RecoveryTarget) => ('lsn' in rt ? `recovery_target_lsn=${rt.lsn}` : `recovery_target_time=${rt.time.toISOString().replace('T', ' ').replace('Z', '+00')}`);

/**
 * Once PostgreSQL is up: recovery ended at the target and promoted. `psql` runs one statement in the container. A target
 * past the WAL makes PostgreSQL stop, in its own words, which `logs` holds.
 */
export async function recovered(rt: RecoveryTarget, startedOk: boolean, logs: string, psql: (sql: string) => string, newest: string | undefined, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string[]> {
  const what = 'lsn' in rt ? rt.lsn : rt.time.toISOString();
  if (/recovery ended before configured recovery target was reached/.test(logs)) return [`target not reached: PostgreSQL ran out of WAL before ${what} (the newest segment it had: ${newest ?? 'none'})`];
  if (!startedOk) return [`PostgreSQL did not recover: ${tail(logs)}`];
  for (let i = 0; i < 120 && psql('SELECT pg_is_in_recovery()') !== 'f'; i++) await wait(2000);
  if (psql('SELECT pg_is_in_recovery()') !== 'f') return ['PostgreSQL is still in recovery after 4 minutes: it did not reach its target'];
  if ('lsn' in rt && psql(`SELECT pg_last_wal_replay_lsn() >= '${rt.lsn.replace(/[^0-9A-Fa-f/]/g, '')}'::pg_lsn`) !== 't') return [`PostgreSQL promoted before replaying to ${rt.lsn}: target not reached`];
  return [];
}

/**
 * B2-6 step 6 on a Vault started empty: initialised with throwaway keys (in memory, never written), the snapshot
 * restored, then sealed with the set's own root token and opened with the set's own unseal key (BK5's second half), so
 * the set's key is always what opens it. `dir` holds the set's vault-init.json.
 */
export async function restoreSnapshot(target: VaultTarget, snapshot: Readable, dir: string, run: Runner = docker): Promise<string[]> {
  const init = vaultCli(run, ['operator', 'init', '-key-shares=1', '-key-threshold=1', '-format=json'], {}, undefined, target);
  if (init.status !== 0) return [`the restore's Vault did not initialise (exit ${String(init.status)})`];
  const throwaway = JSON.parse(init.stdout) as { unseal_keys_b64: string[]; root_token: string };
  if (vaultCli(run, ['write', '-format=json', 'sys/unseal', 'key=-'], {}, throwaway.unseal_keys_b64[0] ?? '', target).status !== 0) return ["the restore's Vault did not unseal with its throwaway key"];
  const restored = await pipeInto(['exec', '-i', ...cliEnv(target), '-e', 'VAULT_TOKEN', target.container, 'vault', 'operator', 'raft', 'snapshot', 'restore', '-force', '/dev/stdin'], snapshot, { VAULT_TOKEN: throwaway.root_token });
  if (restored.status !== 0) return [`the Vault snapshot did not restore: ${tail(restored.stderr)}`];
  const { rootToken } = loadVaultInit(dir);
  if (vaultState(run, target) === 'ready' && vaultCli(run, ['operator', 'seal'], { VAULT_TOKEN: rootToken }, undefined, target).status !== 0)
    return ["the restored Vault doesn't accept the set's root token (it couldn't be sealed with it): the snapshot isn't the set's"];
  if (vaultState(run, target) !== 'sealed') return ['the restored Vault did not seal'];
  unseal(run, dir, target);
  const state = vaultState(run, target);
  return state === 'ready' ? [] : [`the restored Vault is ${state} after unsealing with the set's key`];
}

/**
 * B2-8: `files.tar`'s objects written through the filer of the SeaweedFS reachable as `seaweedfs` on `network`, each read
 * back over S3 and hashed in the container; the problems, judged object by object. The S3 identity reaches the
 * container by name only.
 */
export async function restoreFilesThrough(network: string, files: AsyncIterable<Buffer>, s3: { accessKey: string; secretKey: string }): Promise<{ objects: number; problems: string[] }> {
  const { stream, sent } = scratchTar(files);
  const r = await pipeInto(
    ['run', '-i', '--rm', '--network', network, '--label', `${LABEL}=1`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '1000:1000',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-e', 'S3_ACCESS_KEY', '-e', 'S3_SECRET_KEY', '-v', `${FILES_SCRATCH}:/scratch`, '--entrypoint', 'sh', THIRD_PARTY.seaweedfs, '-c', CONTAINER_SCRIPT],
    Readable.from(stream as AsyncIterable<Buffer>),
    { S3_ACCESS_KEY: s3.accessKey, S3_SECRET_KEY: s3.secretKey },
  );
  if (r.status !== 0) return { objects: sent.length, problems: [`the files' container failed: ${tail(r.stderr)}`] };
  return { objects: sent.length, problems: filesProblems(sent, r.stdout) };
}
