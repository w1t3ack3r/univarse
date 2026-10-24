// Spec 0019 D9/C2/C3: the stack's Vault. It publishes no port; everything goes through `docker exec` into its
// container, with the Vault CLI against its own listener: over TLS, verified against the stack CA under the name
// `vault` (C2). Secrets travel by environment (`-e NAME`) or stdin, never as arguments, and are never printed.
//   pnpm stack:vault status | init | unseal | migrate-raft <releases/record.json>   (the CLI is vault-cli.ts)
// `init` runs once: one unseal share (as in development), stored with the root token and the app's least-privilege
// token in STACK_DIR/vault-init.json, owner-only. After a restart Vault is sealed: the owner runs `unseal`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { STACK_DIR } from './config.js';
import { docker, type Runner } from './docker.js';
import type { VaultTokens } from './render.js';

export const VAULT_CONTAINER = 'univarse-stack-vault-1';
const MOUNT = 'transit';
const KEK = 'univarse-kek';
const POLICY = 'univarse-app';
/** Spec 0020 B-4: the backup's policy: a Raft snapshot, read; nothing else (no Transit, no restore, no tokens). */
export const BACKUP_POLICY = 'univarse-backup';
export const BACKUP_POLICY_HCL = 'path "sys/storage/raft/snapshot" { capabilities = ["read"] }\n';
/** C3: the file audit device, on the audit volume (the image's /vault/logs, owned by the vault user). */
export const AUDIT_LOG = '/vault/logs/audit.log';

/** Which Vault: the stack's (TLS, C2), or another set up the same way (C4's throwaway, on its own loopback listener). */
export interface VaultTarget {
  readonly container: string;
  readonly tls: boolean;
}
export const STACK_VAULT: VaultTarget = { container: VAULT_CONTAINER, tls: true };

export interface VaultInit {
  readonly unsealKey: string;
  readonly rootToken: string;
  readonly appToken: string;
  /** Spec 0020 B-4: reads Raft snapshots and nothing else (the backup's); absent until the first configure on B1. */
  readonly backupToken?: string;
}
export type VaultState = 'absent' | 'uninitialised' | 'sealed' | 'ready';

const vaultFile = (dir = STACK_DIR) => join(dir, 'vault-init.json');

/** The CLI's view of its own listener: over TLS, the stack CA and the certificate's name; otherwise plain loopback. */
export const cliEnv = (t: VaultTarget) =>
  t.tls ? ['-e', 'VAULT_ADDR=https://127.0.0.1:8200', '-e', 'VAULT_CACERT=/vault/tls/ca.crt', '-e', 'VAULT_TLS_SERVER_NAME=vault'] : ['-e', 'VAULT_ADDR=http://127.0.0.1:8200'];

/** `vault <args>` inside the container, against its own listener; `env` values reach it by name only. */
export function vaultCli(run: Runner, args: readonly string[], env: Record<string, string> = {}, input?: string, target: VaultTarget = STACK_VAULT) {
  const names = Object.keys(env).flatMap((k) => ['-e', k]);
  return run(['exec', ...(input === undefined ? [] : ['-i']), ...cliEnv(target), ...names, target.container, 'vault', ...args], { env, input, allowFail: true });
}

export function vaultState(run: Runner = docker, target: VaultTarget = STACK_VAULT): VaultState {
  const r = vaultCli(run, ['status', '-format=json'], {}, undefined, target);
  // `vault status` exits 2 when sealed, still printing its JSON; anything unparseable means not reachable.
  try {
    const s = JSON.parse(r.stdout) as { initialized: boolean; sealed: boolean };
    if (!s.initialized) return 'uninitialised';
    return s.sealed ? 'sealed' : 'ready';
  } catch {
    return 'absent';
  }
}

export function loadVaultInit(dir = STACK_DIR): VaultInit {
  const f = vaultFile(dir);
  if (!existsSync(f)) throw new Error(`no ${f}: run pnpm stack:vault init`);
  return JSON.parse(readFileSync(f, 'utf8')) as VaultInit;
}

export function unseal(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): void {
  const { unsealKey } = loadVaultInit(dir);
  // The key through stdin: `key=-` makes `vault write` read the value from there (`operator unseal -` takes "-" as
  // the key itself). sys/unseal is unauthenticated.
  const r = vaultCli(run, ['write', '-format=json', 'sys/unseal', 'key=-'], {}, unsealKey, target);
  if (r.status !== 0) throw new Error(`unseal failed (exit ${String(r.status)})`);
}

/** First use: initialise, save the unseal key and root token at once (before anything else can fail), unseal, configure. */
export function initialise(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): VaultInit {
  if (existsSync(vaultFile(dir))) throw new Error(`${vaultFile(dir)} exists: this Vault was initialised already (unseal it instead)`);
  const r = vaultCli(run, ['operator', 'init', '-key-shares=1', '-key-threshold=1', '-format=json'], {}, undefined, target);
  if (r.status !== 0) throw new Error(`vault operator init failed (exit ${String(r.status)})`);
  const out = JSON.parse(r.stdout) as { unseal_keys_b64: string[]; root_token: string };
  writeOwnerOnly(vaultFile(dir), `${JSON.stringify({ unsealKey: out.unseal_keys_b64[0] ?? '', rootToken: out.root_token, appToken: '' }, null, 2)}\n`);
  unseal(run, dir, target);
  return configure(run, dir, target);
}

/**
 * The audit device (C3), Transit, the KEK, the app policy and the app's least-privilege token. Idempotent and
 * resumable: each part is created only if missing, so a first deploy that stopped half-way is completed by the next.
 * The audit device comes first, so everything after it is recorded.
 */
export function configure(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): VaultInit {
  const init = loadVaultInit(dir);
  const root = { VAULT_TOKEN: init.rootToken };
  const must = (args: string[], what: string, input?: string) => {
    const x = vaultCli(run, args, root, input, target);
    if (x.status !== 0) throw new Error(`${what} failed (exit ${String(x.status)})`);
    return x;
  };
  // Vault's defaults HMAC every request and response value (log_raw off); a failing device blocks requests.
  const devices = JSON.parse(must(['audit', 'list', '-format=json'], 'listing audit devices').stdout || '{}') as Record<string, unknown>;
  if (!('file/' in devices)) must(['audit', 'enable', 'file', `file_path=${AUDIT_LOG}`], 'enabling the audit device');
  const mounts = JSON.parse(must(['secrets', 'list', '-format=json'], 'listing secrets engines').stdout) as Record<string, unknown>;
  if (!(`${MOUNT}/` in mounts)) must(['secrets', 'enable', '-path', MOUNT, 'transit'], 'enabling Transit');
  if (vaultCli(run, ['read', '-format=json', `${MOUNT}/keys/${KEK}`], root, undefined, target).status !== 0)
    must(['write', '-f', `${MOUNT}/keys/${KEK}`, 'type=aes256-gcm96', 'derived=true'], 'creating the KEK');
  const policy = `path "${MOUNT}/encrypt/${KEK}" { capabilities = ["update"] }\npath "${MOUNT}/decrypt/${KEK}" { capabilities = ["update"] }\n`;
  must(['policy', 'write', POLICY, '-'], 'writing the app policy', policy);
  must(['policy', 'write', BACKUP_POLICY, '-'], 'writing the backup policy', BACKUP_POLICY_HCL);
  const token = (p: string, what: string) =>
    (JSON.parse(must(['token', 'create', '-policy', p, '-no-default-policy', '-period', '768h', '-orphan', '-format=json'], what).stdout) as { auth: { client_token: string } }).auth.client_token;
  let done = init;
  // Each token is saved as soon as it exists, so a stop between the two never orphans one.
  if (!done.appToken) {
    done = { ...done, appToken: token(POLICY, 'creating the app token') };
    writeOwnerOnly(vaultFile(dir), `${JSON.stringify(done, null, 2)}\n`);
  }
  if (!done.backupToken) {
    done = { ...done, backupToken: token(BACKUP_POLICY, 'creating the backup token') };
    writeOwnerOnly(vaultFile(dir), `${JSON.stringify(done, null, 2)}\n`);
  }
  return done;
}

/** For the deploy: initialise on first use, otherwise complete whatever is missing. A sealed Vault is the owner's step. */
export function ensureVault(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): VaultInit {
  const state = vaultState(run, target);
  if (state === 'uninitialised') return initialise(run, dir, target);
  if (state !== 'ready') throw new Error(`Vault is ${state}`);
  return configure(run, dir, target);
}

export const tokensOf = (v: VaultInit): VaultTokens => ({ appToken: v.appToken });
