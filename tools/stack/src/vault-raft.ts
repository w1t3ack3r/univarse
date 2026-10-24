// Spec 0020 D4, B-4: the stack's Vault moves from file storage to integrated (Raft) storage, once, offline, with the
// old volume kept untouched (mounted read-only by the migration, never written or deleted here).
//
// What the deploy may do depends on what the two volumes hold and on the marker a verified migration writes
// (STACK_DIR/vault-raft.json):
//   raft     Raft data and the marker, or Raft data and no file data (a stack born on Raft): proceed;
//   fresh    neither: a first deploy, which initialises Vault on Raft;
//   unmigrated   file data and no Raft data: refused, naming `pnpm stack:vault migrate-raft`;
//   unverified   Raft data, file data, no marker (a migration stopped or failed part-way): refused the same way.
// So no deploy ever starts the app on a half-migrated Vault, nor initialises a second Vault beside the first.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { REPO, STACK_DIR, THIRD_PARTY } from './config.js';
import { docker, hostPath, type Runner } from './docker.js';
import { loadVaultInit, unseal, vaultCli, vaultState, type VaultTarget, STACK_VAULT } from './vault.js';

export const RAFT_VOLUME = 'univarse-stack-vault-raft';
/** Compose names the file storage's volume itself (the project's `vault-data`). */
export const FILE_VOLUME = 'univarse-stack_vault-data';
const MIGRATE_HCL = join(REPO, 'infra', 'stack', 'vault', 'migrate.hcl');
const VAULT_USER = '100:1000';
const markerFile = (dir = STACK_DIR) => join(dir, 'vault-raft.json');
/** The first attempt's "before" (the KEK's shape, the probe's ciphertext; neither secret), so a retry compares to it. */
const pendingFile = (dir = STACK_DIR) => join(dir, 'vault-raft.pending.json');

export type VaultStorage = 'raft' | 'fresh' | 'unmigrated' | 'unverified';
/** The two volumes. The stack's, except in the integration test, which must never touch a real stack's. */
export interface VaultVolumes {
  readonly raft: string;
  readonly file: string;
}
export const STACK_VOLUMES: VaultVolumes = { raft: RAFT_VOLUME, file: FILE_VOLUME };

/**
 * True when `volume` exists and holds `path`: checked read-only, with no network, in the pinned PostgreSQL image, as the
 * vault user, who owns both volumes (root with every capability dropped can't search a 0700 directory it doesn't own).
 */
function volumeHolds(run: Runner, volume: string, path: string): boolean {
  if (run(['volume', 'inspect', volume], { allowFail: true }).status !== 0) return false;
  if (!/^[a-z/.]+$/.test(path)) throw new Error(`bad path ${path}`);
  return run(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', VAULT_USER, '-v', `${volume}:/v:ro`, '--entrypoint', 'test', THIRD_PARTY.postgres, '-e', `/v/${path}`], { allowFail: true }).status === 0;
}

export function vaultStorage(run: Runner = docker, dir = STACK_DIR, volumes: VaultVolumes = STACK_VOLUMES): VaultStorage {
  const raft = volumeHolds(run, volumes.raft, 'vault.db');
  const file = volumeHolds(run, volumes.file, 'core');
  if (raft) return file && !existsSync(markerFile(dir)) ? 'unverified' : 'raft';
  return file ? 'unmigrated' : 'fresh';
}

export function storageProblem(s: VaultStorage): string | null {
  if (s === 'unmigrated')
    return "Vault still holds its data in file storage, and this release runs it on Raft (spec 0020 D4): run `pnpm stack:vault migrate-raft <this record>` once, then deploy again. Nothing was started.";
  if (s === 'unverified')
    return 'a migration of Vault to Raft was started but never verified: run `pnpm stack:vault migrate-raft <this record>` again (it starts over from the untouched file storage). Nothing was started.';
  return null;
}

/** The KEK's metadata that must survive the migration unchanged: its versions, their times, its type. */
export interface KekShape {
  readonly type: string;
  readonly derived: boolean;
  readonly latest_version: number;
  readonly min_decryption_version: number;
  readonly keys: Readonly<Record<string, number>>;
}

export interface MigrateDeps {
  readonly run: Runner;
  readonly target: VaultTarget;
  readonly dir: string;
  readonly volumes?: VaultVolumes;
  /** compose against the stack, with the verified images of the record being deployed. */
  compose(args: readonly string[]): { status: number };
  /** The new image's `keys verify-unwrap`: every active DEK unwraps (B-14); exit 0 or not. */
  verifyUnwrap(): { ok: boolean; lines: string[] };
  ensureDataVolumes(): void;
  log(line: string): void;
}

function kekShape(d: MigrateDeps, token: string): KekShape {
  const r = vaultCli(d.run, ['read', '-format=json', 'transit/keys/univarse-kek'], { VAULT_TOKEN: token }, undefined, d.target);
  if (r.status !== 0) throw new Error(`reading the KEK's metadata failed (exit ${String(r.status)})`);
  const k = (JSON.parse(r.stdout) as { data: KekShape }).data;
  return { type: k.type, derived: k.derived, latest_version: k.latest_version, min_decryption_version: k.min_decryption_version, keys: k.keys };
}

const PROBE_CONTEXT = Buffer.from('univarse-raft-migration-probe').toString('base64');

function probeEncrypt(d: MigrateDeps, appToken: string, plaintext: string): string {
  const r = vaultCli(d.run, ['write', '-format=json', 'transit/encrypt/univarse-kek', `context=${PROBE_CONTEXT}`, 'plaintext=-'], { VAULT_TOKEN: appToken }, plaintext, d.target);
  if (r.status !== 0) throw new Error(`the probe's encryption failed (exit ${String(r.status)})`);
  return (JSON.parse(r.stdout) as { data: { ciphertext: string } }).data.ciphertext;
}

function probeDecrypt(d: MigrateDeps, appToken: string, ciphertext: string): string | null {
  const r = vaultCli(d.run, ['write', '-format=json', 'transit/decrypt/univarse-kek', `context=${PROBE_CONTEXT}`, `ciphertext=${ciphertext}`], { VAULT_TOKEN: appToken }, undefined, d.target);
  return r.status === 0 ? (JSON.parse(r.stdout) as { data: { plaintext: string } }).data.plaintext : null;
}

const canonical = (k: KekShape) =>
  JSON.stringify([k.type, k.derived, k.latest_version, k.min_decryption_version, Object.entries(k.keys).sort(([a], [b]) => Number(a) - Number(b))]);

interface Before {
  readonly kek: KekShape;
  readonly probe: string;
  readonly ciphertext: string;
}

function storageType(d: MigrateDeps): string | null {
  const r = vaultCli(d.run, ['status', '-format=json'], {}, undefined, d.target);
  try {
    return (JSON.parse(r.stdout) as { storage_type?: string }).storage_type ?? null;
  } catch {
    return null;
  }
}

/**
 * The one-time migration (B-4). Vault must be running on file storage, unsealed. In order:
 *   1. before: the KEK's metadata (root token) and a probe encrypted with the APP token;
 *   2. stop Vault; empty the Raft volume (a stopped earlier attempt); `vault operator migrate`, file storage read-only;
 *   3. start Vault on Raft, unseal it with the same key;
 *   4. after: the KEK's metadata identical, the probe decrypts with the app token, and every active DEK unwraps
 *      (the release's own `keys verify-unwrap`);
 *   5. only then the marker, so the deploy proceeds.
 * Any failure stops before the marker: the deploy keeps refusing, the file storage is as it was, and running this
 * again starts over.
 */
export function migrateRaft(d: MigrateDeps): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    d.log(l);
  };
  const vol = d.volumes ?? STACK_VOLUMES;
  const storage = vaultStorage(d.run, d.dir, vol);
  if (storage === 'raft') return { ok: true, lines: ['Vault already runs on Raft, verified: nothing to do'] };
  if (storage === 'fresh') return { ok: false, lines: ['there is no Vault data to migrate: deploy, and the first deploy initialises Vault on Raft'] };
  const init = loadVaultInit(d.dir);

  // "Before" is read only from Vault on its file storage, once; a retry (an unverified attempt) reuses it, so it
  // never compares against a half-copied Raft.
  let before: Before;
  if (existsSync(pendingFile(d.dir))) {
    before = JSON.parse(readFileSync(pendingFile(d.dir), 'utf8')) as Before;
    say('starting over from the untouched file storage; comparing with the first attempt\'s record of the KEK and its probe');
  } else {
    if (storage === 'unverified') return { ok: false, lines: ['an unverified migration exists without its record of "before": nothing can be compared; restore the Raft volume to empty and run Vault on its file storage (the previous release), then run this again'] };
    if (vaultState(d.run, d.target) !== 'ready' || storageType(d) !== 'file')
      return { ok: false, lines: ['Vault must be running on its file storage, unsealed, first (`pnpm stack:vault unseal`)'] };
    const probe = Buffer.from(`uv-probe-${String(Date.now())}`).toString('base64');
    before = { kek: kekShape(d, init.rootToken), probe, ciphertext: probeEncrypt(d, init.appToken, probe) };
    writeOwnerOnly(pendingFile(d.dir), `${JSON.stringify(before, null, 2)}\n`);
  }
  say(`before: KEK at version ${String(before.kek.latest_version)} (${String(Object.keys(before.kek.keys).length)} versions); a probe encrypted with the app token`);

  if (d.compose(['stop', 'vault']).status !== 0) return { ok: false, lines: [...lines, 'Vault did not stop'] };
  d.ensureDataVolumes();
  // A stopped earlier attempt's partial copy: only ever the Raft volume, and only while it is unverified.
  d.run(['run', '--rm', '--network', 'none', '--user', VAULT_USER, '-v', `${vol.raft}:/r`, '--entrypoint', 'sh', THIRD_PARTY.postgres, '-c', 'find /r -mindepth 1 -delete']);
  // `vault operator migrate` writes a lock key into its SOURCE storage, so it can't read the file storage read-only. It
  // reads a copy instead (a scratch volume, removed afterwards): the file storage itself is only ever read.
  const scratch = `${vol.raft}-source`;
  let m: { status: number; stdout: string; stderr: string };
  try {
    d.run(['volume', 'create', scratch]);
    d.run(['run', '--rm', '--network', 'none', '--user', '0:0', '-v', `${vol.file}:/src:ro`, '-v', `${scratch}:/dst`, '--entrypoint', 'sh', THIRD_PARTY.postgres, '-c',
      `find /dst -mindepth 1 -delete && cp -a /src/. /dst/ && chown -R ${VAULT_USER} /dst && chmod 0700 /dst`]);
    m = d.run(
      ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--user', VAULT_USER,
        '-v', `${scratch}:/vault/file`, '-v', `${vol.raft}:/vault/raft`, '-v', `${hostPath(MIGRATE_HCL)}:/vault/config/migrate.hcl:ro`,
        '--entrypoint', 'vault', THIRD_PARTY.vault, 'operator', 'migrate', '-config=/vault/config/migrate.hcl'],
      { allowFail: true },
    );
  } finally {
    d.run(['volume', 'rm', '-f', scratch], { allowFail: true });
  }
  if (m.status !== 0 || !/All of the keys have been migrated/.test(m.stdout + m.stderr)) {
    // Vault's own error lines name storage paths, never values.
    const why = `${m.stdout}\n${m.stderr}`.split('\n').filter((l) => /^Error/.test(l.trim())).slice(-2).join(' | ');
    return { ok: false, lines: [...lines, `vault operator migrate failed (exit ${String(m.status)})${why ? `: ${why}` : ''}; the file storage is untouched; run this again`] };
  }
  say('migrated: every key copied to Raft from a copy of the file storage (the file storage itself was only read)');

  if (d.compose(['up', '-d', '--wait', 'vault']).status !== 0) return { ok: false, lines: [...lines, 'Vault did not start on Raft'] };
  if (vaultState(d.run, d.target) === 'sealed') unseal(d.run, d.dir, d.target);
  if (vaultState(d.run, d.target) !== 'ready') return { ok: false, lines: [...lines, 'Vault on Raft did not unseal with the same key'] };

  const after = kekShape(d, init.rootToken);
  if (canonical(before.kek) !== canonical(after)) return { ok: false, lines: [...lines, "the KEK's metadata changed in the migration: not verified"] };
  if (probeDecrypt(d, init.appToken, before.ciphertext) !== before.probe) return { ok: false, lines: [...lines, "the probe doesn't decrypt with the app token on Raft: not verified"] };
  say('after: the KEK is identical, and the probe decrypts with the app token');
  const v = d.verifyUnwrap();
  for (const l of v.lines) say(l);
  if (!v.ok) return { ok: false, lines: [...lines, 'not every active data key unwraps through the migrated Vault: not verified. The file storage is untouched: fix what the keys job says above and run this again'] };

  rmSync(pendingFile(d.dir), { force: true });
  writeOwnerOnly(markerFile(d.dir), `${JSON.stringify({ migratedAt: new Date().toISOString(), kek: { latestVersion: after.latest_version, versions: Object.keys(after.keys).length } }, null, 2)}\n`);
  say(`verified and recorded (${markerFile(d.dir)}). The old file storage (${vol.file}) is kept, untouched; deploy now.`);
  return { ok: true, lines };
}

export { STACK_VAULT };
export const readMarker = (dir = STACK_DIR): unknown => (existsSync(markerFile(dir)) ? JSON.parse(readFileSync(markerFile(dir), 'utf8')) : null);
