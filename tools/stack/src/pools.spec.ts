// Spec 0019 B5/LS5: `stack:pools` runs on the internal network with no published port, the password by name only,
// and names the cause of a failure.
import { describe, expect, it } from 'vitest';
import { poolsArgs, poolsFailure } from './pools.js';

describe('[LS5] stack:pools (B5)', () => {
  it('[LS5] runs on the internal app network, publishes nothing, verifies TLS, and passes the password by name only', () => {
    const args = poolsArgs();
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'univarse-stack_app']);
    expect(args).not.toContain('-p');
    expect(args.slice(args.indexOf('-e'), args.indexOf('-e') + 2)).toEqual(['-e', 'PGPASSWORD']); // a name, no value
    expect(args.join(' ')).toContain('sslmode=verify-full sslrootcert=/ca/ca.crt');
    expect(args.join(' ')).not.toMatch(/password=/i);
  });

  it('[LS5] names the cause: PgBouncer down, authentication refused, TLS not verified', () => {
    expect(poolsFailure('psql: error: could not translate host name "pgbouncer" to address')).toMatch(/not reachable/);
    expect(poolsFailure('psql: error: connection to server failed: Connection refused')).toMatch(/not reachable/);
    expect(poolsFailure('FATAL:  password authentication failed for user "pgbouncer_admin"')).toMatch(/refused the admin login/);
    expect(poolsFailure('FATAL:  SASL authentication failed')).toMatch(/refused the admin login/);
    expect(poolsFailure('psql: error: SSL error: certificate verify failed')).toMatch(/TLS to PgBouncer failed verification/);
  });
});
