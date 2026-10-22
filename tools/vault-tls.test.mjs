// Spec 0019 C1: the dev Vault's TLS certificate, made by the real OpenSSL step (needs Docker), checked by OpenSSL:
// it chains to the dev CA and names 127.0.0.1 and localhost; the CA's key is gone; the key is owner-only.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureVaultTls, OPENSSL_IMAGE, SCRIPT } from './vault-tls.mjs';

const dir = mkdtempSync(join(tmpdir(), 'uv-vault-tls-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const mount = process.platform === 'win32' ? dir.replace(/\//g, '\\') : dir;
const openssl = (script) =>
  spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${mount}:/c:ro`, OPENSSL_IMAGE, '-c', script], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

test('[LS8] makes a dev CA and a certificate for 127.0.0.1 and localhost, keeps them, and leaves no CA key', () => {
  assert.equal(ensureVaultTls({ dir }), true);
  for (const f of ['ca.crt', 'vault.crt', 'vault.key']) assert.ok(existsSync(join(dir, f)), f);
  assert.ok(!existsSync(join(dir, 'ca.key')), 'the CA key is deleted once it has signed');
  assert.equal(ensureVaultTls({ dir }), false);
  assert.match(openssl('openssl verify -CAfile /c/ca.crt -purpose sslserver -verify_ip 127.0.0.1 /c/vault.crt').stdout, /vault\.crt: OK/);
  assert.match(openssl('openssl verify -CAfile /c/ca.crt -verify_hostname localhost /c/vault.crt').stdout, /vault\.crt: OK/);
  assert.notEqual(openssl('openssl verify -CAfile /c/ca.crt -verify_hostname vault /c/vault.crt').status, 0, 'no other name');
  assert.match(SCRIPT, /chmod 0600 vault\.key/);
});

test('[LS8] the OpenSSL image is the stack\'s own pin (tools/stack THIRD_PARTY.postgres)', () => {
  const stack = readFileSync(new URL('./stack/src/config.ts', import.meta.url), 'utf8');
  assert.ok(stack.includes(`postgres: '${OPENSSL_IMAGE}'`), 'the two pins differ');
});
