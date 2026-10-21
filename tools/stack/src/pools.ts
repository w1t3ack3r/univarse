// Spec 0019 B5/LS5: `pnpm stack:pools` runs SHOW POOLS on the stack's PgBouncer from a throwaway container on the
// internal `app` network: no port is published, the admin password travels by environment name, TLS is verified
// against the stack CA. It fails clearly, naming the cause, when PgBouncer is down or authentication fails.
import { pathToFileURL } from 'node:url';
import { PROJECT, THIRD_PARTY } from './config.js';
import { docker, type Runner } from './docker.js';
import { loadSecrets } from './secrets.js';

const CONNINFO = 'host=pgbouncer port=6432 dbname=pgbouncer user=pgbouncer_admin sslmode=verify-full sslrootcert=/ca/ca.crt connect_timeout=5';

export function poolsArgs(): string[] {
  return [
    'run', '--rm', '--network', `${PROJECT}_app`, '-v', 'univarse-stack-ca:/ca:ro',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', '999:999',
    '-e', 'PGPASSWORD', '--entrypoint', 'psql', THIRD_PARTY.postgres,
    CONNINFO, '--no-psqlrc', '-c', 'SHOW POOLS',
  ];
}

/** psql's failure, as the cause the owner can act on (stderr carries no password: it was never an argument). */
export function poolsFailure(stderr: string): string {
  if (/could not translate host name|Connection refused|timeout expired|No route to host|network .* not found/i.test(stderr))
    return 'PgBouncer is not reachable: is the stack running? (pnpm stack:deploy)';
  if (/password authentication failed|SASL authentication failed|not allowed|no such user/i.test(stderr))
    return 'PgBouncer refused the admin login: the admin password and PgBouncer\'s auth file differ (deploy again to re-render it)';
  if (/certificate|SSL/i.test(stderr)) return 'TLS to PgBouncer failed verification against the stack CA';
  return `SHOW POOLS failed: ${stderr.trim().split('\n').at(-1) ?? ''}`;
}

export function showPools(run: Runner = docker): { ok: boolean; out: string } {
  const r = run(poolsArgs(), { env: { PGPASSWORD: loadSecrets().pgbouncerAdminPassword }, allowFail: true });
  return r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, out: poolsFailure(r.stderr) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, out } = showPools();
  if (!ok) {
    console.error(`[stack:pools] FAIL ${out}`);
    process.exit(1);
  }
  process.stdout.write(out);
}
