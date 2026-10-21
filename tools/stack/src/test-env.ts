// Spec 0019 B4/LS9: the environment the E2E and isolation runs get, built only from STACK_DIR, never the root .env.
// The database URLs reach PgBouncer through the tunnel (127.0.0.1, which PgBouncer's certificate names), verify-full
// against the stack CA. Node trusts the stack CA and the edge CA from one owner-only bundle. Nothing here is printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { certsDir, edgeDir } from './certs.js';
import { STACK_DIR, STACK_DOMAIN, TUNNEL_PORT } from './config.js';
import { dbUrl, type StackSecrets } from './render.js';

const AT = `127.0.0.1:${String(TUNNEL_PORT)}`;

/** The stack CA (PgBouncer) and the edge CA (Caddy) in one file, for NODE_EXTRA_CA_CERTS. */
export function writeCaBundle(dir = STACK_DIR): string {
  const file = join(dir, 'test-ca.pem');
  writeOwnerOnly(file, `${readFileSync(join(certsDir(dir), 'ca.crt'), 'utf8')}${readFileSync(join(edgeDir(dir), 'edge-ca.crt'), 'utf8')}`);
  return file;
}

export function testEnv(s: StackSecrets, caBundle: string): Record<string, string> {
  return {
    E2E_STACK: '1',
    E2E_DOMAIN: STACK_DOMAIN,
    PLATFORM_DATABASE_URL: dbUrl('univarse_app_platform', s.roles.appPlatform, AT, 'univarse_platform'),
    TENANT_POOL_01_DATABASE_URL: dbUrl('univarse_app', s.roles.app, AT, 'univarse_pool_01'),
    PGBOUNCER_ADMIN_URL: dbUrl('pgbouncer_admin', s.pgbouncerAdminPassword, AT, 'pgbouncer'),
    SESSION_PEPPER: s.sessionPepper,
    MAILPIT_URL: `https://mail.${STACK_DOMAIN}`,
    NODE_EXTRA_CA_CERTS: caBundle,
  };
}
