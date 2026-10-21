// DEV/CI ONLY (spec 0019 C1). The dev Vault's TLS listener (127.0.0.1:8201), for the runs of the PRODUCTION images
// against it: in production a plaintext VAULT_ADDR is refused, loopback included. Development keeps its plain
// listener (8200). Makes, once, a throwaway dev CA and a certificate for 127.0.0.1 and localhost, with OpenSSL in the
// stack's pinned PostgreSQL image, offline, into infra/compose/vault/tls (git-ignored):
//   ca.crt      the dev CA, which the production-image containers trust (NODE_EXTRA_CA_CERTS, tools/images/container.mjs)
//   vault.crt   Vault's certificate; vault.key its key, owned by the vault user (100:1000), 0600
// The CA's key is deleted once it has signed: nothing can be issued from it later. `--rotate` replaces all three.
// Nothing here is secret beyond vault.key, a dev key for a dev-only listener on loopback.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The same pin as tools/stack/src/config.ts THIRD_PARTY.postgres (tools/stack's compose.spec checks they match).
export const OPENSSL_IMAGE = 'postgres:18@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336';
export const TLS_DIR = fileURLToPath(new URL('../infra/compose/vault/tls/', import.meta.url));

/** The OpenSSL script: fixed commands over fixed names; no input from outside. */
export const SCRIPT = [
  'set -eu',
  'cd /out',
  'openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key 2>/dev/null',
  "openssl req -x509 -new -key ca.key -sha256 -days 825 -subj '/CN=UniVarse dev Vault CA (dev and CI only)' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out ca.crt",
  'openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out vault.key 2>/dev/null',
  "openssl req -new -key vault.key -subj '/CN=dev vault' -out vault.csr",
  "printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\nsubjectAltName=IP:127.0.0.1,DNS:localhost\\n' > vault.ext",
  'openssl x509 -req -in vault.csr -CA ca.crt -CAkey ca.key -set_serial 0x$(openssl rand -hex 16) -days 825 -sha256 -extfile vault.ext -out vault.crt 2>/dev/null',
  'rm ca.key vault.csr vault.ext',
  'chown 100:1000 vault.crt vault.key ca.crt',
  'chmod 0644 vault.crt ca.crt',
  'chmod 0600 vault.key',
].join('\n');

export function ensureVaultTls({ rotate = false, dir = TLS_DIR } = {}) {
  if (existsSync(join(dir, 'vault.crt')) && existsSync(join(dir, 'ca.crt')) && !rotate) return false;
  mkdirSync(dir, { recursive: true });
  const mount = process.platform === 'win32' ? dir.replace(/\//g, '\\').replace(/\\$/, '') : dir.replace(/\/$/, '');
  const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${mount}:/out`, OPENSSL_IMAGE, '-c', SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (r.status !== 0) throw new Error(`making the dev Vault certificate failed: ${(r.stderr ?? '').trim().split('\n').at(-1) ?? ''}`);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const made = ensureVaultTls({ rotate: process.argv.includes('--rotate') });
  console.log(made ? 'dev Vault TLS: CA and certificate made (infra/compose/vault/tls, git-ignored)' : 'dev Vault TLS: certificate kept (--rotate replaces it)');
}
