// DEV/CI ONLY (ADR-023, spec 0006). Makes a running Vault ready for UniVarse:
//   1. local: initialise once (1 unseal share) and unseal on every start; keys go to the git-ignored
//      .vault-dev.json, never to .env or stdout.   CI: Vault runs in dev mode; VAULT_ROOT_TOKEN is set.
//   2. ensure the Transit engine, the derived aes256-gcm96 KEK, and the app policy (encrypt/decrypt only)
//   3. ensure .env holds a working least-privilege app token (VAULT_TOKEN) plus KEY_PROVIDER/VAULT_ADDR,
//      and (dev/CI only) the operator key-admin token VAULT_ADMIN_TOKEN for the `keys` CLI and tests.
// Never prints a secret.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const envPath = new URL('../.env', import.meta.url);
const keyFile = new URL('../.vault-dev.json', import.meta.url);
const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const envVal = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1];

const ADDR = process.env.VAULT_ADDR ?? envVal('VAULT_ADDR') ?? 'http://127.0.0.1:8200';
const MOUNT = process.env.VAULT_TRANSIT_MOUNT ?? envVal('VAULT_TRANSIT_MOUNT') ?? 'transit';
const KEY = process.env.VAULT_TRANSIT_KEY ?? envVal('VAULT_TRANSIT_KEY') ?? 'univarse-kek';
const POLICY = 'univarse-app';
const ADMIN_POLICY = 'univarse-key-admin';

async function vault(method, path, { token, body, ok = [200, 204] } = {}) {
  const res = await fetch(`${ADDR}/v1/${path}`, {
    method,
    headers: { ...(token ? { 'x-vault-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!ok.includes(res.status)) throw new Error(`Vault ${method} ${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function waitForVault() {
  for (let i = 0; i < 60; i++) {
    try {
      await vault('GET', 'sys/health', { ok: [200, 429, 472, 473, 501, 503] });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Vault not reachable at ${ADDR}`);
}

async function rootToken() {
  if (process.env.VAULT_ROOT_TOKEN) return process.env.VAULT_ROOT_TOKEN; // CI dev mode
  const init = await vault('GET', 'sys/init');
  let keys = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : null;
  if (!init.initialized) {
    const out = await vault('PUT', 'sys/init', { body: { secret_shares: 1, secret_threshold: 1 } });
    keys = { unsealKey: out.keys_base64[0], rootToken: out.root_token };
    writeFileSync(keyFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log('Vault initialised (keys in .vault-dev.json, git-ignored)');
  }
  if (!keys) throw new Error('Vault is initialised but .vault-dev.json is missing: reset the vault-data volume');
  const seal = await vault('GET', 'sys/seal-status');
  if (seal.sealed) {
    await vault('PUT', 'sys/unseal', { body: { key: keys.unsealKey } });
    console.log('Vault unsealed');
  }
  return keys.rootToken;
}

async function main() {
  await waitForVault();
  const root = await rootToken();

  const mounts = await vault('GET', 'sys/mounts', { token: root });
  if (!mounts[`${MOUNT}/`] && !mounts.data?.[`${MOUNT}/`]) {
    await vault('POST', `sys/mounts/${MOUNT}`, { token: root, body: { type: 'transit' } });
    console.log(`Transit enabled at ${MOUNT}/`);
  }
  const existing = await vault('GET', `${MOUNT}/keys/${KEY}`, { token: root, ok: [200, 404] });
  if (!existing.data) {
    await vault('POST', `${MOUNT}/keys/${KEY}`, { token: root, body: { type: 'aes256-gcm96', derived: true } });
    console.log(`KEK ${MOUNT}/${KEY} created (aes256-gcm96, derived)`);
  } else if (!existing.data.derived) {
    throw new Error(`${MOUNT}/${KEY} exists but is not derived: per-tenant binding (spec 0006 E2) requires derived=true`);
  }
  const policy = `path "${MOUNT}/encrypt/${KEY}" { capabilities = ["update"] }\npath "${MOUNT}/decrypt/${KEY}" { capabilities = ["update"] }\n`;
  await vault('PUT', `sys/policies/acl/${POLICY}`, { token: root, body: { policy } });

  // Operator key admin (spec 0006 E8): rotate the KEK, read its metadata, rewrap DEKs. Never the app's.
  const adminPolicy = [
    `path "${MOUNT}/keys/${KEY}" { capabilities = ["read"] }`,
    `path "${MOUNT}/keys/${KEY}/rotate" { capabilities = ["update"] }`,
    `path "${MOUNT}/rewrap/${KEY}" { capabilities = ["update"] }`,
  ].join('\n');
  await vault('PUT', `sys/policies/acl/${ADMIN_POLICY}`, { token: root, body: { policy: adminPolicy } });

  // Keep working tokens; otherwise mint periodic, least-privilege ones.
  const ensureToken = async (envKey, policyName, label) => {
    let token = process.env.CI ? undefined : envVal(envKey);
    if (token) {
      // These tokens have no default policy, so they can't look themselves up; root checks them.
      const found = await vault('POST', 'auth/token/lookup', { token: root, body: { token }, ok: [200, 403] });
      if (!found.data?.policies?.includes(policyName)) token = undefined;
    }
    if (!token) {
      const out = await vault('POST', 'auth/token/create', {
        token: root,
        body: { policies: [policyName], no_default_policy: true, period: '768h', display_name: `${policyName}-dev`, renewable: true },
      });
      token = out.auth.client_token;
      console.log(`Issued ${label}`);
    }
    return token;
  };
  const appToken = await ensureToken('VAULT_TOKEN', POLICY, 'a least-privilege app token (encrypt/decrypt only)');
  // DEV/CI ONLY: in deployed environments this is an operator credential, never in the app's env.
  const adminToken = await ensureToken('VAULT_ADMIN_TOKEN', ADMIN_POLICY, 'an operator key-admin token (rotate/rewrap; CLI only)');

  let next = env.endsWith('\n') || env === '' ? env : env + '\n';
  const set = (k, v) => {
    next = new RegExp(`^${k}=`, 'm').test(next) ? next.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : next + `${k}=${v}\n`;
  };
  set('KEY_PROVIDER', 'vault');
  set('VAULT_ADDR', ADDR);
  set('VAULT_TOKEN', appToken);
  set('VAULT_ADMIN_TOKEN', adminToken);
  writeFileSync(envPath, next, { mode: 0o600 });
  console.log('Vault ready for UniVarse (.env updated)');
}

main().catch((err) => {
  console.error(`vault-dev: ${err.message}`);
  process.exit(1);
});
