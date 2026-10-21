// Spec 0019 D7/B2: the stack's two certificate authorities, made by `pnpm stack:init` with OpenSSL in the pinned
// PostgreSQL image, offline, into STACK_DIR (owner-only). ECDSA P-256. No CA key ever leaves STACK_DIR: containers get
// CA certificates and their own key and certificate only (volumes.ts).
//   • certs/: the internal stack CA (D7) and the server certificates for PostgreSQL, PgBouncer and Vault. Nothing
//     outside the stack trusts it, so it is reissued freely (a new CERTS_VERSION, or --rotate).
//   • edge/: the edge CA (B2), name-constrained to stack.univarse.localhost, and Caddy's wildcard certificate. The owner
//     installs this CA in Windows' trust store (`pnpm stack:trust`), so it changes only with --rotate-edge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STACK_DIR, STACK_DOMAIN, THIRD_PARTY } from './config.js';
import { docker, hostPath, type Runner } from './docker.js';

/**
 * Each server's certificate names: its service name on the stack's networks. PgBouncer is also reached through B4's
 * tunnel on 127.0.0.1, and node-postgres hands TLS no host for an IP address, so Node checks the name `localhost`:
 * both are named, and verify-full holds there too.
 */
export const SERVER_NAMES = Object.freeze({
  postgres: ['DNS:postgres'],
  pgbouncer: ['DNS:pgbouncer', 'DNS:localhost', 'IP:127.0.0.1'],
  vault: ['DNS:vault'],
});
export const SERVERS = Object.keys(SERVER_NAMES) as (keyof typeof SERVER_NAMES)[];
/** Bumped when the internal certificates change shape; an older set is reissued by the next `stack:init`. */
export const CERTS_VERSION = '3';
export const certsDir = (dir = STACK_DIR) => join(dir, 'certs');
export const edgeDir = (dir = STACK_DIR) => join(dir, 'edge');

const KEY = (name: string) => `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ${name}.key 2>/dev/null`;
const CA = (name: string, cn: string, extra = '') =>
  `openssl req -x509 -new -key ${name}.key -sha256 -days 825 -subj '/CN=${cn}' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign'${extra} -out ${name}.crt`;
/** A server certificate signed by `ca`, for server use only, with exactly these subject names. */
const LEAF = (name: string, cn: string, sans: readonly string[], ca: string, days: number) => [
  KEY(name),
  `openssl req -new -key ${name}.key -subj '/CN=${cn}' -out ${name}.csr`,
  `printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\nsubjectAltName=${sans.join(',')}\\n' > ${name}.ext`,
  `openssl x509 -req -in ${name}.csr -CA ${ca}.crt -CAkey ${ca}.key -set_serial 0x$(openssl rand -hex 16) -days ${String(days)} -sha256 -extfile ${name}.ext -out ${name}.crt 2>/dev/null`,
  `rm ${name}.csr ${name}.ext`,
];

/** The internal CA's OpenSSL script: fixed commands over fixed names; no input from outside. */
export function certScript(): string {
  return ['set -eu', 'cd /out', KEY('ca'), CA('ca', 'UniVarse local stack CA'), ...SERVERS.flatMap((s) => LEAF(s, s, SERVER_NAMES[s], 'ca', 825))].join('\n');
}

/**
 * The edge CA's script (B2). The CA may sign only for stack.univarse.localhost and its subdomains (RFC 5280 name
 * constraints, critical, which browsers enforce), and signs one wildcard certificate for Caddy. 397 days for the
 * certificate: within what browsers accept for any certificate.
 */
export function edgeScript(): string {
  return [
    'set -eu',
    'cd /out',
    KEY('edge-ca'),
    CA('edge-ca', `UniVarse local stack edge CA (${STACK_DOMAIN} only)`, ` -addext 'nameConstraints=critical,permitted;DNS:${STACK_DOMAIN}'`),
    ...LEAF('edge', `*.${STACK_DOMAIN}`, [`DNS:*.${STACK_DOMAIN}`], 'edge-ca', 397),
  ].join('\n');
}

const runScript = (run: Runner, out: string, script: string) =>
  run(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', `${hostPath(out)}:/out`, THIRD_PARTY.postgres, '-c', script]);

/** Makes the internal CA and its certificates unless a current set exists (or `rotate`). Returns whether it made them. */
export function ensureCerts({ dir = STACK_DIR, rotate = false, run = docker }: { dir?: string; rotate?: boolean; run?: Runner } = {}): boolean {
  const out = certsDir(dir);
  const version = join(out, 'version');
  const current = existsSync(join(out, 'ca.crt')) && existsSync(version) && readFileSync(version, 'utf8').trim() === CERTS_VERSION;
  if (current && !rotate) return false;
  mkdirSync(out, { recursive: true });
  runScript(run, out, certScript());
  writeFileSync(version, `${CERTS_VERSION}\n`);
  return true;
}

/** Makes the edge CA and Caddy's certificate unless they exist (or `rotate`). Returns whether it made them. */
export function ensureEdgeCerts({ dir = STACK_DIR, rotate = false, run = docker }: { dir?: string; rotate?: boolean; run?: Runner } = {}): boolean {
  const out = edgeDir(dir);
  if (existsSync(join(out, 'edge-ca.crt')) && !rotate) return false;
  mkdirSync(out, { recursive: true });
  runScript(run, out, edgeScript());
  return true;
}
