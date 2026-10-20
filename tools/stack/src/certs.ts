// Spec 0019 D7: the stack CA and its server certificates (PostgreSQL, PgBouncer; Vault for PR C), made once by
// `pnpm stack:init` with OpenSSL in the pinned PostgreSQL image, offline, into STACK_DIR/certs (owner-only).
// ECDSA P-256, 825 days. The CA key never leaves STACK_DIR/certs; containers get only the CA certificate and
// their own key and certificate (volumes.ts).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STACK_DIR, THIRD_PARTY } from './config.js';
import { docker, hostPath, type Runner } from './docker.js';

/** Each server's certificate names: its service name on the stack's networks. */
export const SERVERS = ['postgres', 'pgbouncer', 'vault'] as const;
export const certsDir = (dir = STACK_DIR) => join(dir, 'certs');

/** The OpenSSL script: fixed commands over fixed names; no input from outside. */
export function certScript(): string {
  const lines = [
    'set -eu',
    'cd /out',
    "openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key 2>/dev/null",
    "openssl req -x509 -new -key ca.key -sha256 -days 825 -subj '/CN=UniVarse local stack CA' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out ca.crt",
  ];
  for (const s of SERVERS)
    lines.push(
      `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ${s}.key 2>/dev/null`,
      `openssl req -new -key ${s}.key -subj '/CN=${s}' -out ${s}.csr`,
      `printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\nsubjectAltName=DNS:${s}\\n' > ${s}.ext`,
      `openssl x509 -req -in ${s}.csr -CA ca.crt -CAkey ca.key -set_serial 0x$(openssl rand -hex 16) -days 825 -sha256 -extfile ${s}.ext -out ${s}.crt 2>/dev/null`,
      `rm ${s}.csr ${s}.ext`,
    );
  return lines.join('\n');
}

/** Makes the CA and the certificates unless they exist (or `rotate`). Returns whether it made them. */
export function ensureCerts({ dir = STACK_DIR, rotate = false, run = docker }: { dir?: string; rotate?: boolean; run?: Runner } = {}): boolean {
  const out = certsDir(dir);
  if (existsSync(join(out, 'ca.crt')) && !rotate) return false;
  mkdirSync(out, { recursive: true });
  run(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${hostPath(out)}:/out`, THIRD_PARTY.postgres, '-c', certScript()]);
  return true;
}
