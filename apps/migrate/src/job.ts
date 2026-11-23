// Spec 0019 D3/LS4, spec 0039 Q9: the migrate job, in order:
//   1. bootstrap: roles, databases and privileges, as the superuser (only when its variables are given);
//   2. the platform's migrations (`prisma migrate deploy`, direct to PostgreSQL, never PgBouncer), recorded as a run.
//      A platform failure stops the job: every shard depends on it;
//   3. every shard's migrations, each recorded, each with its own rls:check (shards.ts). A shard that fails is put in
//      maintenance and the job goes on to the next;
//   4. the idempotent seed, on SEED_DOMAIN, unless its pool is in maintenance;
//   5. tenant data keys (spec 0006 E11), through the key provider.
// It returns the shards that failed: the caller exits 3 for those (the platform and every other shard migrated).
// With `--check-only` (spec 0020 B-14, the restore rehearsal's check of a restored database) it changes nothing: the
// platform's and every shard's migration status must be up to date, and every shard passes rls:check.
// The steps are injected so the order and the stops are unit-tested; main.ts wires the real ones. Errors name
// variables, never their values.
import { vaultAddrProblem } from '@univarse/crypto';
import type { ShardsResult } from './shards.js';
import { verifiesServer } from './tls.js';

export const REQUIRED = [
  'PLATFORM_MIGRATOR_URL',
  'TENANT_POOL_01_MIGRATOR_URL',
  'PLATFORM_DATABASE_URL',
  'TENANT_POOL_01_DATABASE_URL',
  'SEED_DOMAIN',
] as const;
/** Bootstrap runs only with all of these, or is skipped with none (an already bootstrapped database). */
export const BOOTSTRAP = [
  'BOOTSTRAP_SUPERUSER_URL',
  'ROLE_VERIFIER_MIGRATOR',
  'ROLE_VERIFIER_APP',
  'ROLE_VERIFIER_APP_PLATFORM',
  'ROLE_VERIFIER_RELAY_PLATFORM',
] as const;

/**
 * Optional with the bootstrap, each role created only when its verifier is given: spec 0020 B-3's backup role, and
 * spec 0027 P5's console role (the platform API's; CONNECT on the platform database only).
 */
export const BOOTSTRAP_OPTIONAL = ['ROLE_VERIFIER_BACKUP', 'ROLE_VERIFIER_CONSOLE'] as const;

const DOMAIN = /^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type JobEnv = Readonly<Record<string, string | undefined>>;

export interface JobSteps {
  bootstrap(env: JobEnv): Promise<void>;
  /** The platform's migrations, recorded as a run (spec 0039 Q8); rejects on failure. */
  migratePlatform(env: JobEnv): Promise<void>;
  /** Q9: every shard's migrations, each recorded; one shard's failure never stops the next. */
  migrateShards(env: JobEnv): Promise<ShardsResult>;
  /** Rejects unless every platform migration is applied and none failed (`prisma migrate status`); changes nothing. */
  status(which: 'platform'): Promise<void>;
  /** --check-only: every shard's migration status and rls:check; the problems, by shard name. Changes nothing. */
  checkShards(env: JobEnv): Promise<readonly string[]>;
  seed(env: JobEnv): Promise<void>;
  provisionKeys(env: JobEnv): Promise<void>;
  log(line: string): void;
}

/** The pool the seed writes to (its institutions live there). */
export const SEED_SHARD = 'pool-01';

export interface JobResult {
  /** The shards whose migration failed, now in maintenance (empty when everything migrated). */
  readonly failedShards: ShardsResult['failed'];
}

/** What's wrong with the environment, by name only. */
export function envProblems(env: JobEnv): string[] {
  const problems: string[] = [];
  for (const k of REQUIRED) if (!env[k]) problems.push(`${k} is not set`);
  for (const k of ['PLATFORM_MIGRATOR_URL', 'TENANT_POOL_01_MIGRATOR_URL', 'PLATFORM_DATABASE_URL', 'TENANT_POOL_01_DATABASE_URL', 'BOOTSTRAP_SUPERUSER_URL'])
    if (env[k] && !env[k].startsWith('postgresql://')) problems.push(`${k} is not a postgresql:// URL`);
    // D7: in production every connection verifies PostgreSQL's certificate (src/tls.ts); refused before anything runs.
    else if (env[k] && env.NODE_ENV === 'production' && !verifiesServer(env[k])) problems.push(`${k} must say sslmode=verify-full with sslrootcert in production`);
  if (env.SEED_DOMAIN && !DOMAIN.test(env.SEED_DOMAIN)) problems.push('SEED_DOMAIN is not a lower-case domain name');
  // Spec 0019 C1: refused at start, before anything is migrated (the key step comes last).
  const vault = vaultAddrProblem({ KEY_PROVIDER: env.KEY_PROVIDER === 'local' ? 'local' : 'vault', NODE_ENV: env.NODE_ENV, VAULT_ADDR: env.VAULT_ADDR });
  if (vault) problems.push(vault);
  const given = BOOTSTRAP.filter((k) => env[k]);
  if (given.length > 0 && given.length < BOOTSTRAP.length)
    problems.push(`bootstrap needs all of ${BOOTSTRAP.join(', ')}, or none (missing: ${BOOTSTRAP.filter((k) => !env[k]).join(', ')})`);
  for (const k of BOOTSTRAP_OPTIONAL) if (env[k] && !given.length) problems.push(`${k} is given without the bootstrap`);
  return problems;
}

export async function runJob(env: JobEnv, steps: JobSteps, { checkOnly = false }: { checkOnly?: boolean } = {}): Promise<JobResult> {
  const problems = envProblems(env);
  if (problems.length) throw new Error(`invalid environment:\n  ${problems.join('\n  ')}`);

  if (checkOnly) {
    steps.log('[migrate] check-only: migration status (platform)');
    await steps.status('platform');
    steps.log('[migrate] check-only: every shard (migration status, rls:check)');
    const shardProblems = await steps.checkShards(env);
    if (shardProblems.length) throw new Error(`check-only failed (${String(shardProblems.length)} problem(s)):\n  ${shardProblems.join('\n  ')}`);
    steps.log('[migrate] check-only: done, nothing changed');
    return { failedShards: [] };
  }

  if (env.BOOTSTRAP_SUPERUSER_URL) {
    steps.log('[migrate] bootstrap: roles, databases, privileges');
    await steps.bootstrap(env);
  } else steps.log('[migrate] bootstrap skipped (no superuser given)');

  steps.log('[migrate] migrations: platform');
  await steps.migratePlatform(env);

  steps.log('[migrate] migrations: every shard');
  const { migrated, failed } = await steps.migrateShards(env);
  if (migrated.length === 0 && failed.length === 0) steps.log('[migrate] WARN no shard to migrate');

  if (failed.some((f) => f.name === SEED_SHARD)) steps.log(`[migrate] seed skipped: ${SEED_SHARD} is in maintenance`);
  else {
    steps.log(`[migrate] seed on ${env.SEED_DOMAIN ?? ''}`);
    await steps.seed(env);
  }

  steps.log('[migrate] tenant data keys');
  await steps.provisionKeys(env);
  if (failed.length) steps.log(`[migrate] done, except: ${failed.map((f) => `${f.name} (${f.code})`).join(', ')} in maintenance`);
  else steps.log('[migrate] done');
  return { failedShards: failed };
}
