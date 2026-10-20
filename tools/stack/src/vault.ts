// Spec 0019 D9: the stack's Vault. It publishes no port; everything goes through `docker exec` into its container,
// with the Vault CLI against its own listener. Secrets travel by environment (`-e NAME`) or stdin, never as
// arguments, and are never printed.
//   pnpm stack:vault status | init | unseal
// `init` runs once: one unseal share (as in development), stored with the root token and the app's least-privilege
// token in STACK_DIR/vault-init.json, owner-only. After a restart Vault is sealed: the owner runs `unseal`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { STACK_DIR } from './config.js';
import { docker, type Runner } from './docker.js';
import type { VaultTokens } from './render.js';

export const VAULT_CONTAINER = 'univarse-stack-vault-1';
const MOUNT = 'transit';
const KEK = 'univarse-kek';
const POLICY = 'univarse-app';

export interface VaultInit {
  readonly unsealKey: string;
  readonly rootToken: string;
  readonly appToken: string;
}
export type VaultState = 'absent' | 'uninitialised' | 'sealed' | 'ready';

const vaultFile = (dir = STACK_DIR) => join(dir, 'vault-init.json');

/** `vault <args>` inside the container, against its own listener; `env` values reach it by name only. */
function vaultCli(run: Runner, args: readonly string[], env: Record<string, string> = {}, input?: string) {
  const names = Object.keys(env).flatMap((k) => ['-e', k]);
  return run(['exec', ...(input === undefined ? [] : ['-i']), '-e', 'VAULT_ADDR=http://127.0.0.1:8200', ...names, VAULT_CONTAINER, 'vault', ...args], { env, input, allowFail: true });
}

export function vaultState(run: Runner = docker): VaultState {
  const r = vaultCli(run, ['status', '-format=json']);
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

export function unseal(run: Runner = docker, dir = STACK_DIR): void {
  const { unsealKey } = loadVaultInit(dir);
  // The key through stdin: `key=-` makes `vault write` read the value from there (`operator unseal -` takes "-" as
  // the key itself). sys/unseal is unauthenticated.
  const r = vaultCli(run, ['write', '-format=json', 'sys/unseal', 'key=-'], {}, unsealKey);
  if (r.status !== 0) throw new Error(`unseal failed (exit ${String(r.status)})`);
}

/** First use: initialise, save the unseal key and root token at once (before anything else can fail), unseal, configure. */
export function initialise(run: Runner = docker, dir = STACK_DIR): VaultInit {
  if (existsSync(vaultFile(dir))) throw new Error(`${vaultFile(dir)} exists: this Vault was initialised already (unseal it instead)`);
  const r = vaultCli(run, ['operator', 'init', '-key-shares=1', '-key-threshold=1', '-format=json']);
  if (r.status !== 0) throw new Error(`vault operator init failed (exit ${String(r.status)})`);
  const out = JSON.parse(r.stdout) as { unseal_keys_b64: string[]; root_token: string };
  writeOwnerOnly(vaultFile(dir), `${JSON.stringify({ unsealKey: out.unseal_keys_b64[0] ?? '', rootToken: out.root_token, appToken: '' }, null, 2)}\n`);
  unseal(run, dir);
  return configure(run, dir);
}

/**
 * Transit, the KEK, the app policy and the app's least-privilege token. Idempotent and resumable: each part is
 * created only if missing, so a first deploy that stopped half-way is completed by the next.
 */
export function configure(run: Runner = docker, dir = STACK_DIR): VaultInit {
  const init = loadVaultInit(dir);
  const root = { VAULT_TOKEN: init.rootToken };
  const must = (args: string[], what: string, input?: string) => {
    const x = vaultCli(run, args, root, input);
    if (x.status !== 0) throw new Error(`${what} failed (exit ${String(x.status)})`);
    return x;
  };
  const mounts = JSON.parse(must(['secrets', 'list', '-format=json'], 'listing secrets engines').stdout) as Record<string, unknown>;
  if (!(`${MOUNT}/` in mounts)) must(['secrets', 'enable', '-path', MOUNT, 'transit'], 'enabling Transit');
  if (vaultCli(run, ['read', '-format=json', `${MOUNT}/keys/${KEK}`], root).status !== 0)
    must(['write', '-f', `${MOUNT}/keys/${KEK}`, 'type=aes256-gcm96', 'derived=true'], 'creating the KEK');
  const policy = `path "${MOUNT}/encrypt/${KEK}" { capabilities = ["update"] }\npath "${MOUNT}/decrypt/${KEK}" { capabilities = ["update"] }\n`;
  must(['policy', 'write', POLICY, '-'], 'writing the app policy', policy);
  if (init.appToken) return init;
  const tok = must(['token', 'create', '-policy', POLICY, '-no-default-policy', '-period', '768h', '-orphan', '-format=json'], 'creating the app token');
  const done = { ...init, appToken: (JSON.parse(tok.stdout) as { auth: { client_token: string } }).auth.client_token };
  writeOwnerOnly(vaultFile(dir), `${JSON.stringify(done, null, 2)}\n`);
  return done;
}

/** For the deploy: initialise on first use, otherwise complete whatever is missing. A sealed Vault is the owner's step. */
export function ensureVault(run: Runner = docker, dir = STACK_DIR): VaultInit {
  const state = vaultState(run);
  if (state === 'uninitialised') return initialise(run, dir);
  if (state !== 'ready') throw new Error(`Vault is ${state}`);
  return configure(run, dir);
}

export const tokensOf = (v: VaultInit): VaultTokens => ({ appToken: v.appToken });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  const state = vaultState();
  if (cmd === 'status') console.log(`[stack:vault] ${state}`);
  else if (cmd === 'unseal') {
    if (state !== 'sealed') console.log(`[stack:vault] nothing to do: Vault is ${state}`);
    else {
      unseal();
      console.log(`[stack:vault] unsealed: ${vaultState()}`);
    }
  } else if (cmd === 'init') {
    if (state !== 'uninitialised') console.log(`[stack:vault] nothing to do: Vault is ${state}`);
    else {
      initialise();
      console.log('[stack:vault] initialised and unsealed; Transit, the KEK and the app token are ready (saved owner-only)');
    }
  } else {
    console.error('usage: pnpm stack:vault status | init | unseal');
    process.exit(2);
  }
}
