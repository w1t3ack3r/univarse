// Spec 0019 D7/LS5 and B2/LS7: the stack CA and its server certificates, and the name-constrained edge CA, made with
// the real OpenSSL step (the pinned PostgreSQL image, no network), then checked by OpenSSL itself: each chains to its
// CA, is for server use, and names exactly what it should. Needs Docker.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STACK_DOMAIN, THIRD_PARTY } from './config.js';
import { certsDir, edgeDir, ensureCerts, ensureEdgeCerts, SERVER_NAMES, SERVERS } from './certs.js';
import { docker, hostPath } from './docker.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uv-stack-certs-'));
  expect(ensureCerts({ dir })).toBe(true);
  expect(ensureEdgeCerts({ dir })).toBe(true);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const opensslIn = (mount: string, script: string) =>
  docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${hostPath(mount)}:/c:ro`, THIRD_PARTY.postgres, '-c', script], { allowFail: true });
const openssl = (script: string) => opensslIn(certsDir(dir), script);
const edgeSsl = (script: string) => opensslIn(edgeDir(dir), script);

describe('[LS5] the stack CA and its server certificates', () => {
  it('[LS5] a CA, and a key and certificate per server; a second init keeps them, and the edge CA', () => {
    for (const f of ['ca.key', 'ca.crt', 'version', ...SERVERS.flatMap((s) => [`${s}.key`, `${s}.crt`])]) expect([f, existsSync(join(certsDir(dir), f))]).toEqual([f, true]);
    expect(ensureCerts({ dir })).toBe(false);
    expect(ensureEdgeCerts({ dir })).toBe(false);
  });

  for (const server of SERVERS)
    it(`[LS5] ${server}'s certificate chains to the stack CA, for server use, naming ${server} only`, () => {
      const v = openssl(`openssl verify -CAfile /c/ca.crt -purpose sslserver /c/${server}.crt`);
      expect(v.stdout).toContain(`/c/${server}.crt: OK`);
      const text = openssl(`openssl x509 -in /c/${server}.crt -noout -ext subjectAltName,basicConstraints`).stdout;
      // Exactly its own names: the service name, and for PgBouncer alone the tunnel's (B4).
      const names = [...text.matchAll(/(DNS:[\w.-]+|IP Address:[\d.]+)/g)].map((m) => (m[1] ?? '').replace('IP Address:', 'IP:')).sort();
      expect(names).toEqual([...SERVER_NAMES[server]].sort());
      expect(text).toMatch(/CA:FALSE/);
      // Another server's name is not accepted for this certificate.
      const other = SERVERS.find((s) => s !== server) ?? 'x';
      expect(openssl(`openssl verify -CAfile /c/ca.crt -verify_hostname ${other} /c/${server}.crt`).status).not.toBe(0);
    });

  it('[LS5] the CA is a CA that may sign certificates only (no server use of its own)', () => {
    const text = openssl('openssl x509 -in /c/ca.crt -noout -ext basicConstraints,keyUsage').stdout;
    expect(text).toMatch(/CA:TRUE, pathlen:0/);
    expect(text).toMatch(/Certificate Sign, CRL Sign/);
  });
});

describe("[LS7] the edge CA (B2): what the owner trusts can vouch only for the stack's names", () => {
  /** A certificate for `name`, signed with the edge CA's own key, then verified against the edge CA. */
  const signed = (name: string) =>
    edgeSsl(
      [
        'set -eu',
        'cd /tmp',
        'openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out x.key 2>/dev/null',
        `openssl req -new -key x.key -subj '/CN=${name}' -out x.csr`,
        `printf 'basicConstraints=critical,CA:FALSE\\nextendedKeyUsage=serverAuth\\nsubjectAltName=DNS:${name}\\n' > x.ext`,
        'openssl x509 -req -in x.csr -CA /c/edge-ca.crt -CAkey /c/edge-ca.key -set_serial 7 -days 1 -sha256 -extfile x.ext -out x.crt 2>/dev/null',
        'openssl verify -CAfile /c/edge-ca.crt -purpose sslserver x.crt 2>&1 || true',
      ].join('\n'),
    ).stdout;

  it("[LS7] Caddy's wildcard certificate chains to the edge CA and serves a tenant's name, for server use", () => {
    const v = edgeSsl(`openssl verify -CAfile /c/edge-ca.crt -purpose sslserver -verify_hostname demo-uni.${STACK_DOMAIN} /c/edge.crt`);
    expect(v.stdout).toContain('/c/edge.crt: OK');
    const text = edgeSsl('openssl x509 -in /c/edge.crt -noout -ext subjectAltName,basicConstraints').stdout;
    expect(text).toContain(`DNS:*.${STACK_DOMAIN}`);
    expect(text).toMatch(/CA:FALSE/);
  });

  it('[LS7] the edge CA is name-constrained (critical) to stack.univarse.localhost', () => {
    const text = edgeSsl('openssl x509 -in /c/edge-ca.crt -noout -ext nameConstraints,basicConstraints').stdout;
    expect(text).toMatch(/Name Constraints: critical/);
    expect(text).toContain(`DNS:${STACK_DOMAIN}`);
    expect(text).toMatch(/CA:TRUE, pathlen:0/);
  });

  it('[LS7] a certificate the edge CA signs for any other name is refused (permitted subtree violation)', () => {
    for (const name of ['www.google.com', 'univarse.localhost', 'demo-uni.univarse.localhost'])
      expect([name, signed(name)]).toEqual([name, expect.stringMatching(/permitted subtree violation/)]);
    // The control: inside the constraint, the same steps verify.
    expect(signed(`x.${STACK_DOMAIN}`)).toContain('x.crt: OK');
  });

  it("[LS7] the edge CA is separate from the internal stack CA: neither verifies the other's certificates", () => {
    expect(opensslIn(dir, 'openssl verify -CAfile /c/certs/ca.crt /c/edge/edge.crt').status).not.toBe(0);
    expect(opensslIn(dir, 'openssl verify -CAfile /c/edge/edge-ca.crt /c/certs/pgbouncer.crt').status).not.toBe(0);
  });
});
