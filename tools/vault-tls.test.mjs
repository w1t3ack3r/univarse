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

test('[LS8] the release precondition: a sealed or uninitialised dev Vault is refused, an unsealed one passes, an unverifiable one is refused', async () => {
  const { createServer } = await import('node:https');
  const { vaultTlsProblem } = await import('./images/vault-tls.mjs');
  // A self-signed certificate for 127.0.0.1 the test can read (the dev key is the vault user's, unreadable on CI).
  const own = mkdtempSync(join(tmpdir(), 'uv-vault-health-'));
  try {
    const m = process.platform === 'win32' ? own.replace(/\//g, '\\') : own;
    const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${m}:/out`, OPENSSL_IMAGE, '-c',
      "cd /out && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout k.pem -out c.pem -days 1 -subj '/CN=t' -addext 'subjectAltName=IP:127.0.0.1' 2>/dev/null && chmod 0644 k.pem c.pem"],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
    assert.equal(r.status, 0, r.stderr);
    let status = 200;
    const server = createServer({ key: readFileSync(join(own, 'k.pem')), cert: readFileSync(join(own, 'c.pem')) }, (req, res) => {
      res.statusCode = req.url === '/v1/sys/health' ? status : 404;
      res.end('{}');
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const addr = `https://127.0.0.1:${server.address().port}`;
    const caFile = join(own, 'c.pem');
    try {
      assert.equal(await vaultTlsProblem({ caFile, addr }), null);
      status = 429; // a standby node answers too
      assert.equal(await vaultTlsProblem({ caFile, addr }), null);
      status = 503;
      assert.match(await vaultTlsProblem({ caFile, addr }), /the dev Vault is sealed: run pnpm dev:vault/);
      status = 501;
      assert.match(await vaultTlsProblem({ caFile, addr }), /not initialised: run pnpm dev:infra/);
      status = 200;
      assert.match(await vaultTlsProblem({ caFile: join(dir, 'ca.crt'), addr }), /TLS listener .* failed/); // another CA
      assert.match(await vaultTlsProblem({ caFile: join(own, 'missing.crt'), addr }), /no dev Vault CA/);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});
