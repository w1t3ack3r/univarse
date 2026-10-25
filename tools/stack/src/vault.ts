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
/**
 * Spec 0023 T1: a token's own renewal and lookup. The tokens have no default policy (which is where Vault grants
 * these), so each policy grants them explicitly, and nothing else about tokens.
 */
export const SELF_HCL = 'path "auth/token/renew-self" { capabilities = ["update"] }\npath "auth/token/lookup-self" { capabilities = ["read"] }\n';
/** The app's policy: Transit encrypt and decrypt on the KEK (spec 0006), and its own renewal (T1). */
export const APP_POLICY_HCL = `path "${MOUNT}/encrypt/${KEK}" { capabilities = ["update"] }\npath "${MOUNT}/decrypt/${KEK}" { capabilities = ["update"] }\n${SELF_HCL}`;
/** Spec 0020 B-4: the backup's policy: a Raft snapshot, read (no Transit, no restore), and its own renewal (T1). */
export const BACKUP_POLICY = 'univarse-backup';
export const BACKUP_POLICY_HCL = `path "sys/storage/raft/snapshot" { capabilities = ["read"] }\n${SELF_HCL}`;
/** Spec 0023: both tokens are periodic: each renewal resets its TTL to this period. */
export const TOKEN_PERIOD = '768h';
/** T5: below this, the smoke check fails (a week to act on a renewal that has failed for three weeks). */
export const TOKEN_MIN_TTL_S = 7 * 24 * 3600;
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
  /** Spec 0023 T6: each token's accessor (for a lookup or a revocation without the token); never printed either. */
  readonly appTokenAccessor?: string;
  readonly backupTokenAccessor?: string;
}

/** The stack's two periodic tokens, by their fields in vault-init.json (spec 0023). */
export const TOKENS = [
  { name: 'app', token: 'appToken', accessor: 'appTokenAccessor', policy: 'univarse-app' },
  { name: 'backup', token: 'backupToken', accessor: 'backupTokenAccessor', policy: BACKUP_POLICY },
] as const;
export type TokenName = (typeof TOKENS)[number]['name'];

/**
 * Spec 0023 T9: what a failed Vault call means. A sealed Vault (503, after every restart) is never a dead token, and
 * a dead token is only Vault's own "bad token" or "invalid token". Anything else is an error, reported in Vault's
 * words with anything shaped like a token redacted.
 */
export type VaultFailure = { readonly kind: 'sealed' } | { readonly kind: 'bad_token' } | { readonly kind: 'error'; readonly detail: string };
export const redactTokens = (s: string) => s.replace(/\b(hv[sbr]|s|b|r)\.[A-Za-z0-9_-]{8,}/g, '<token>').replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
export function classifyVaultFailure(r: { status: number | null; stderr: string }): VaultFailure {
  if (/Vault is sealed/i.test(r.stderr)) return { kind: 'sealed' };
  if (/\bbad token\b|\binvalid token\b/i.test(r.stderr)) return { kind: 'bad_token' };
  const said = redactTokens(r.stderr.replace(/\s+/g, ' ').trim()).slice(0, 300);
  return { kind: 'error', detail: `exit ${String(r.status)}${said ? `: ${said}` : ''}` };
}
export const SEALED_LINE = 'Vault is sealed: run `pnpm stack:vault unseal` (spec 0019 D9)';
export const describeFailure = (f: VaultFailure) =>
  f.kind === 'sealed' ? SEALED_LINE : f.kind === 'bad_token' ? 'Vault says the token is invalid or expired' : f.detail;

/** A token's remaining life, from a lookup. Never the token. */
export interface TokenInfo {
  readonly ttlSeconds: number;
  readonly expireTime: string | null;
  readonly period: number | null;
  readonly accessor: string;
}
type Looked = { readonly ok: true; readonly info: TokenInfo } | { readonly ok: false; readonly failure: VaultFailure };
const infoOf = (stdout: string): TokenInfo => {
  const d = (JSON.parse(stdout) as { data: { ttl: number; expire_time?: string | null; period?: number; accessor?: string } }).data;
  return { ttlSeconds: d.ttl, expireTime: d.expire_time ?? null, period: d.period ?? null, accessor: d.accessor ?? '' };
};

/**
 * A token looked up with the root token: the token itself goes by stdin (`token=-`), never as an argument. This is
 * the only lookup that works for a token that can't look itself up, or is dead.
 */
export function lookupToken(run: Runner, rootToken: string, token: string, target: VaultTarget = STACK_VAULT): Looked {
  const r = vaultCli(run, ['write', '-format=json', 'auth/token/lookup', 'token=-'], { VAULT_TOKEN: rootToken }, token, target);
  return r.status === 0 ? { ok: true, info: infoOf(r.stdout) } : { ok: false, failure: classifyVaultFailure(r) };
}

/** T3: a token renews itself (`token renew` with it in VAULT_TOKEN, by name), back to its full period (T1's policy). */
export function renewToken(run: Runner, token: string, target: VaultTarget = STACK_VAULT): { ok: true; ttlSeconds: number } | { ok: false; failure: VaultFailure } {
  const r = vaultCli(run, ['token', 'renew', '-format=json'], { VAULT_TOKEN: token }, undefined, target);
  if (r.status !== 0) return { ok: false, failure: classifyVaultFailure(r) };
  return { ok: true, ttlSeconds: (JSON.parse(r.stdout) as { auth: { lease_duration: number } }).auth.lease_duration };
}

/** `27.1 days, until 2026-11-21T19:42:31Z`. */
export const lifeOf = (ttlSeconds: number, expireTime: string | null) =>
  `${(Math.round(ttlSeconds / 8640) / 10).toFixed(1)} days${expireTime ? `, until ${expireTime.replace(/\.\d+Z$/, 'Z')}` : ''}`;
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
export function initialise(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT, opts: ConfigureOptions = {}): Configured {
  if (existsSync(vaultFile(dir))) throw new Error(`${vaultFile(dir)} exists: this Vault was initialised already (unseal it instead)`);
  const r = vaultCli(run, ['operator', 'init', '-key-shares=1', '-key-threshold=1', '-format=json'], {}, undefined, target);
  if (r.status !== 0) throw new Error(`vault operator init failed (exit ${String(r.status)})`);
  const out = JSON.parse(r.stdout) as { unseal_keys_b64: string[]; root_token: string };
  writeOwnerOnly(vaultFile(dir), `${JSON.stringify({ unsealKey: out.unseal_keys_b64[0] ?? '', rootToken: out.root_token, appToken: '' }, null, 2)}\n`);
  unseal(run, dir, target);
  return configure(run, dir, target, opts);
}

/** Spec 0023: a test's short token period (a few seconds, to see a token expire). Never exposed by the CLI. */
export interface ConfigureOptions {
  readonly period?: string;
}

/**
 * The audit device (C3), Transit, the KEK, the policies and the two least-privilege tokens. Idempotent and resumable:
 * each part is created only if missing, so a first deploy that stopped half-way is completed by the next. The audit
 * device comes first, so everything after it is recorded. A token Vault says is dead is re-issued (spec 0023 T4).
 */
export function configure(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT, opts: ConfigureOptions = {}): Configured {
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
  // The policies are rewritten every time, so an existing token gains a policy's new paths (T1) at the next deploy:
  // a token's policies are evaluated by name.
  must(['policy', 'write', POLICY, '-'], 'writing the app policy', APP_POLICY_HCL);
  must(['policy', 'write', BACKUP_POLICY, '-'], 'writing the backup policy', BACKUP_POLICY_HCL);
  const create = (p: string, what: string) => {
    const a = (JSON.parse(must(['token', 'create', '-policy', p, '-no-default-policy', '-period', opts.period ?? TOKEN_PERIOD, '-orphan', '-format=json'], what).stdout) as { auth: { client_token: string; accessor: string } }).auth;
    return { token: a.client_token, accessor: a.accessor };
  };
  let done: VaultInit = init;
  const save = (next: VaultInit) => {
    done = next;
    writeOwnerOnly(vaultFile(dir), `${JSON.stringify(done, null, 2)}\n`);
  };
  const reissued: TokenName[] = [];
  // Each token is saved as soon as it exists, so a stop between the two never orphans one.
  for (const t of TOKENS) {
    const current = done[t.token];
    if (!current) {
      const c = create(t.policy, `creating the ${t.name} token`);
      save({ ...done, [t.token]: c.token, [t.accessor]: c.accessor });
      continue;
    }
    // T4: a live token is kept (its accessor backfilled once, T6). Only Vault's definite "bad token" re-issues it; a
    // sealed Vault or any other failure stops here, so a Vault fault never mints tokens.
    const l = lookupToken(run, init.rootToken, current, target);
    if (l.ok) {
      if (!done[t.accessor] && l.info.accessor) save({ ...done, [t.accessor]: l.info.accessor });
      continue;
    }
    if (l.failure.kind !== 'bad_token') throw new Error(`looking up the ${t.name} token failed: ${describeFailure(l.failure)}`);
    const c = create(t.policy, `re-issuing the ${t.name} token`);
    save({ ...done, [t.token]: c.token, [t.accessor]: c.accessor });
    reissued.push(t.name);
  }
  return { ...done, reissued };
}

/** What `configure` did to the tokens: those it re-issued because Vault said they were dead (T4). */
export interface Configured extends VaultInit {
  readonly reissued: readonly TokenName[];
}

/**
 * T3: both tokens renewed, each by itself, back to the full period. A failure is reported, never thrown: the token is
 * still valid until its TTL runs out, and the smoke check (T5) fails well before that.
 */
export function renewTokens(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): { ok: boolean; lines: string[] } {
  const init = loadVaultInit(dir);
  const lines: string[] = [];
  let ok = true;
  for (const t of TOKENS) {
    const token = init[t.token];
    if (!token) {
      lines.push(`${t.name} token: none yet (the next deploy creates it)`);
      continue;
    }
    const r = renewToken(run, token, target);
    if (r.ok) lines.push(`${t.name} token: renewed, ${lifeOf(r.ttlSeconds, null)}`);
    else {
      ok = false;
      lines.push(`${t.name} token: not renewed: ${describeFailure(r.failure)}${r.failure.kind === 'bad_token' ? ' (`pnpm stack:deploy` re-issues it)' : ''}`);
    }
  }
  return { ok, lines };
}

/**
 * Spec 0023: the backup renews its own token at the start of each run, back to its full period. A sealed Vault or a
 * dead token stops the run in its own words (the snapshot would fail anyway, less clearly). Any other renewal failure
 * doesn't: the token still has its TTL, the snapshot decides, and the smoke check and `status` show the TTL falling.
 */
export function renewBeforeSnapshot(run: Runner, backupToken: string, target: VaultTarget = STACK_VAULT): string | null {
  const r = renewToken(run, backupToken, target);
  if (r.ok || r.failure.kind === 'error') return null;
  return r.failure.kind === 'sealed' ? SEALED_LINE : 'the backup token is invalid or expired: `pnpm stack:deploy` re-issues it (spec 0023 T4)';
}

/** One token's state for T5: looked up, missing from vault-init.json, or a failed lookup. */
export type TokenState = { readonly name: TokenName } & ({ readonly info: TokenInfo } | { readonly missing: true } | { readonly failure: VaultFailure });

/**
 * Spec 0023 T5: each token's remaining life, a line each; a problem when one has under 7 days left, is missing or can't
 * be looked up. Never a token. The smoke check fails on its problems; `stack:backup status` warns with them.
 */
export function tokenReport(states: readonly TokenState[], minTtlS = TOKEN_MIN_TTL_S): { problems: string[]; lines: string[] } {
  const problems: string[] = [];
  const lines: string[] = [];
  for (const s of states) {
    if ('missing' in s) problems.push(`the ${s.name} token is missing from vault-init.json: deploy once (its Vault step creates it)`);
    else if ('failure' in s) problems.push(`the ${s.name} token could not be looked up: ${describeFailure(s.failure)}${s.failure.kind === 'bad_token' ? ' (`pnpm stack:deploy` re-issues it)' : ''}`);
    else {
      lines.push(`the ${s.name} token has ${lifeOf(s.info.ttlSeconds, s.info.expireTime)}`);
      if (s.info.ttlSeconds < minTtlS)
        problems.push(`the ${s.name} token has only ${lifeOf(s.info.ttlSeconds, s.info.expireTime)}, under ${String(minTtlS / 86400)} days: its renewal is failing (run \`pnpm stack:vault renew\`, and see the API's and worker's logs)`);
    }
  }
  return { problems, lines };
}

/** The live input to tokenReport: each token looked up with the root token (the token on stdin, never an argument). */
export function tokenStates(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): TokenState[] {
  const init = loadVaultInit(dir);
  return TOKENS.map((t): TokenState => {
    const token = init[t.token];
    if (!token) return { name: t.name, missing: true };
    const l = lookupToken(run, init.rootToken, token, target);
    return l.ok ? { name: t.name, info: l.info } : { name: t.name, failure: l.failure };
  });
}

/**
 * For the deploy: initialise on first use, otherwise complete whatever is missing, re-issue a dead token (T4), then
 * renew both (T3). A sealed Vault is the owner's step.
 */
export function ensureVault(run: Runner = docker, dir = STACK_DIR, target: VaultTarget = STACK_VAULT): Configured & { renewal: { ok: boolean; lines: string[] } } {
  const state = vaultState(run, target);
  if (state === 'sealed') throw new Error(SEALED_LINE);
  if (state !== 'ready' && state !== 'uninitialised') throw new Error(`Vault is ${state}`);
  const configured = state === 'uninitialised' ? initialise(run, dir, target) : configure(run, dir, target);
  return { ...configured, renewal: renewTokens(run, dir, target) };
}

export const tokensOf = (v: VaultInit): VaultTokens => ({ appToken: v.appToken });

/**
 * The tokens the env files carry: vault-init.json's whenever it exists, so a deploy that stops before its Vault step
 * (a refusal, say) never rewrites keys.env and api.env with a blank VAULT_TOKEN, which the API's config refuses.
 * Required when `withVault`; blank only before Vault was ever initialised.
 */
export function envTokens(withVault: boolean, dir = STACK_DIR): VaultTokens {
  if (!withVault && !existsSync(vaultFile(dir))) return { appToken: '' };
  return tokensOf(loadVaultInit(dir));
}
