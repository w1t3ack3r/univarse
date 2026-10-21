// Spec 0019 D3/LS4: the migrate job, in order, stopping at the first failure:
//   1. bootstrap: roles, databases and privileges, as the superuser (only when its variables are given);
//   2. migrations: platform, then the tenant pool (`prisma migrate deploy`, direct to PostgreSQL, never PgBouncer);
//   3. rls:check, the static isolation gate, which fails the job;
//   4. the idempotent seed, on SEED_DOMAIN;
//   5. tenant data keys (spec 0006 E11), through the key provider.
// The steps are injected so the order and the stops are unit-tested; main.ts wires the real ones. Errors name
// variables, never their values.
import { vaultAddrProblem } from '@univarse/crypto';

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

const DOMAIN = /^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type JobEnv = Readonly<Record<string, string | undefined>>;

export interface JobSteps {
  bootstrap(env: JobEnv): Promise<void>;
  migrate(which: 'platform' | 'tenant'): Promise<void>;
  rlsCheck(env: JobEnv): Promise<{ problems: string[]; tables: number }>;
  seed(env: JobEnv): Promise<void>;
  provisionKeys(env: JobEnv): Promise<void>;
  log(line: string): void;
}

/** What's wrong with the environment, by name only. */
export function envProblems(env: JobEnv): string[] {
  const problems: string[] = [];
  for (const k of REQUIRED) if (!env[k]) problems.push(`${k} is not set`);
  for (const k of ['PLATFORM_MIGRATOR_URL', 'TENANT_POOL_01_MIGRATOR_URL', 'PLATFORM_DATABASE_URL', 'TENANT_POOL_01_DATABASE_URL', 'BOOTSTRAP_SUPERUSER_URL'])
    if (env[k] && !env[k].startsWith('postgresql://')) problems.push(`${k} is not a postgresql:// URL`);
  if (env.SEED_DOMAIN && !DOMAIN.test(env.SEED_DOMAIN)) problems.push('SEED_DOMAIN is not a lower-case domain name');
  // Spec 0019 C1: refused at start, before anything is migrated (the key step comes last).
  const vault = vaultAddrProblem({ KEY_PROVIDER: env.KEY_PROVIDER === 'local' ? 'local' : 'vault', NODE_ENV: env.NODE_ENV, VAULT_ADDR: env.VAULT_ADDR });
  if (vault) problems.push(vault);
  const given = BOOTSTRAP.filter((k) => env[k]);
  if (given.length > 0 && given.length < BOOTSTRAP.length)
    problems.push(`bootstrap needs all of ${BOOTSTRAP.join(', ')}, or none (missing: ${BOOTSTRAP.filter((k) => !env[k]).join(', ')})`);
  return problems;
}

export async function runJob(env: JobEnv, steps: JobSteps): Promise<void> {
  const problems = envProblems(env);
  if (problems.length) throw new Error(`invalid environment:\n  ${problems.join('\n  ')}`);

  if (env.BOOTSTRAP_SUPERUSER_URL) {
    steps.log('[migrate] bootstrap: roles, databases, privileges');
    await steps.bootstrap(env);
  } else steps.log('[migrate] bootstrap skipped (no superuser given)');

  for (const which of ['platform', 'tenant'] as const) {
    steps.log(`[migrate] migrations: ${which}`);
    await steps.migrate(which);
  }

  steps.log('[migrate] rls:check');
  const { problems: isolation, tables } = await steps.rlsCheck(env);
  if (isolation.length) throw new Error(`rls:check failed (${String(isolation.length)} problem(s)):\n  ${isolation.join('\n  ')}`);
  steps.log(`[migrate] rls:check passed: ${String(tables)} tenant tables isolated; platform capture intact`);

  steps.log(`[migrate] seed on ${env.SEED_DOMAIN ?? ''}`);
  await steps.seed(env);

  steps.log('[migrate] tenant data keys');
  await steps.provisionKeys(env);
  steps.log('[migrate] done');
}
