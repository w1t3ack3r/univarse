// Spec 0019 D7/LS5: the stack CA and its server certificates, made with the real OpenSSL step (the pinned
// PostgreSQL image, no network), then checked by OpenSSL itself: each chains to the CA, is for server use, and names
// exactly its service. Needs Docker.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THIRD_PARTY } from './config.js';
import { certsDir, ensureCerts, SERVERS } from './certs.js';
import { docker, hostPath } from './docker.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'uv-stack-certs-'));
  expect(ensureCerts({ dir })).toBe(true);
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const openssl = (script: string) =>
  docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${hostPath(certsDir(dir))}:/c:ro`, THIRD_PARTY.postgres, '-c', script], { allowFail: true });

describe('[LS5] the stack CA and its server certificates', () => {
  it('[LS5] a CA, and a key and certificate per server; a second init keeps them', () => {
    for (const f of ['ca.key', 'ca.crt', ...SERVERS.flatMap((s) => [`${s}.key`, `${s}.crt`])]) expect([f, existsSync(join(certsDir(dir), f))]).toEqual([f, true]);
    expect(ensureCerts({ dir })).toBe(false);
  });

  for (const server of SERVERS)
    it(`[LS5] ${server}'s certificate chains to the stack CA, for server use, naming ${server} only`, () => {
      const v = openssl(`openssl verify -CAfile /c/ca.crt -purpose sslserver /c/${server}.crt`);
      expect(v.stdout).toContain(`/c/${server}.crt: OK`);
      const text = openssl(`openssl x509 -in /c/${server}.crt -noout -ext subjectAltName,basicConstraints`).stdout;
      expect(text).toMatch(new RegExp(`DNS:${server}\\s`));
      expect(text.match(/DNS:/g)?.length).toBe(1); // its own name, and no other
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
