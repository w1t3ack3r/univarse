// Spec 0019 LS4: the migrate job runs its steps in order, stops at the first failure, and names variables, never
// their values.
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP, BOOTSTRAP_OPTIONAL, envProblems, runJob, type JobEnv, type JobSteps } from './job.js';

const SECRET = 'not-a-real-password-0123456789';
const ENV: JobEnv = {
  PLATFORM_MIGRATOR_URL: `postgresql://univarse_migrator:${SECRET}@postgres:5432/univarse_platform`,
  TENANT_POOL_01_MIGRATOR_URL: `postgresql://univarse_migrator:${SECRET}@postgres:5432/univarse_pool_01`,
  PLATFORM_DATABASE_URL: `postgresql://univarse_app_platform:${SECRET}@postgres:5432/univarse_platform`,
  TENANT_POOL_01_DATABASE_URL: `postgresql://univarse_app:${SECRET}@postgres:5432/univarse_pool_01`,
  SEED_DOMAIN: 'stack.univarse.localhost',
};
const WITH_BOOTSTRAP: JobEnv = {
  ...ENV,
  BOOTSTRAP_SUPERUSER_URL: `postgresql://postgres:${SECRET}@postgres:5432/postgres`,
  ROLE_VERIFIER_MIGRATOR: 'SCRAM-SHA-256$4096:a$b:c',
  ROLE_VERIFIER_APP: 'SCRAM-SHA-256$4096:a$b:c',
  ROLE_VERIFIER_APP_PLATFORM: 'SCRAM-SHA-256$4096:a$b:c',
  ROLE_VERIFIER_RELAY_PLATFORM: 'SCRAM-SHA-256$4096:a$b:c',
};

function recorder(fail?: string, isolation: string[] = []) {
  const calls: string[] = [];
  const step = (name: string) => {
    calls.push(name);
    return name === fail ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
  };
  const steps: JobSteps = {
    bootstrap: () => step('bootstrap'),
    migrate: (which) => step(`migrate:${which}`),
    status: (which) => step(`status:${which}`),
    rlsCheck: async () => (await step('rlsCheck'), { problems: isolation, tables: 14 }),
    seed: () => step('seed'),
    provisionKeys: () => step('provisionKeys'),
    log: () => undefined,
  };
  return { calls, steps };
}

describe('[LS4] the migrate job', () => {
  it('[LS4] runs bootstrap, both migrations, rls:check, the seed and the keys, in that order', async () => {
    const r = recorder();
    await runJob(WITH_BOOTSTRAP, r.steps);
    expect(r.calls).toEqual(['bootstrap', 'migrate:platform', 'migrate:tenant', 'rlsCheck', 'seed', 'provisionKeys']);
  });

  it('[LS4] skips bootstrap when no superuser is given', async () => {
    const r = recorder();
    await runJob(ENV, r.steps);
    expect(r.calls[0]).toBe('migrate:platform');
  });

  it('[LS4] stops at the first failure: nothing after a failed migration runs', async () => {
    const r = recorder('migrate:tenant');
    await expect(runJob(WITH_BOOTSTRAP, r.steps)).rejects.toThrow('migrate:tenant failed');
    expect(r.calls).toEqual(['bootstrap', 'migrate:platform', 'migrate:tenant']);
  });

  it('[LS4] a failed rls:check fails the job before the seed', async () => {
    const r = recorder(undefined, ['user_account: row level security not FORCED']);
    await expect(runJob(ENV, r.steps)).rejects.toThrow(/rls:check failed \(1 problem\(s\)\)/);
    expect(r.calls).not.toContain('seed');
  });

  it('[LS4] refuses an incomplete environment before any step, naming variables and never values', async () => {
    const r = recorder();
    const partial = { ...ENV, PLATFORM_DATABASE_URL: undefined, BOOTSTRAP_SUPERUSER_URL: WITH_BOOTSTRAP.BOOTSTRAP_SUPERUSER_URL, SEED_DOMAIN: 'Not A Domain' };
    let message = '';
    try {
      await runJob(partial, r.steps);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(r.calls).toEqual([]);
    expect(message).toMatch(/PLATFORM_DATABASE_URL is not set/);
    expect(message).toMatch(/SEED_DOMAIN is not a lower-case domain name/);
    expect(message).toMatch(new RegExp(`bootstrap needs all of ${BOOTSTRAP.join(', ')}`));
    expect(message).not.toContain(SECRET);
  });

  it('[LS4] a non-postgresql URL is refused', () => {
    expect(envProblems({ ...ENV, PLATFORM_MIGRATOR_URL: 'mysql://x' })).toEqual(['PLATFORM_MIGRATOR_URL is not a postgresql:// URL']);
  });

  it('[LS8] in production a plaintext VAULT_ADDR stops the job before any step (spec 0019 C1); https and development pass', async () => {
    const plain = { ...ENV, NODE_ENV: 'production', KEY_PROVIDER: 'vault', VAULT_ADDR: 'http://127.0.0.1:8200' };
    expect(envProblems(plain)).toEqual([expect.stringMatching(/VAULT_ADDR must be https:\/\/ in production/)]);
    const { steps, calls } = recorder();
    await expect(runJob(plain, steps)).rejects.toThrow(/VAULT_ADDR must be https/);
    expect(calls).toEqual([]);
    expect(envProblems({ ...plain, VAULT_ADDR: 'https://vault:8200' })).toEqual([]);
    expect(envProblems({ ...plain, NODE_ENV: 'development' })).toEqual([]);
  });

  it('[B-14] --check-only checks both migration statuses and rls:check, and changes nothing, even given the bootstrap', async () => {
    const { calls, steps } = recorder();
    await runJob({ ...WITH_BOOTSTRAP, ROLE_VERIFIER_BACKUP: 'SCRAM-SHA-256$4096:a$b:c' }, steps, { checkOnly: true });
    expect(calls).toEqual(['status:platform', 'status:tenant', 'rlsCheck']);
  });

  it('[B-14] --check-only fails on a pending migration, and on an rls:check problem', async () => {
    await expect(runJob(ENV, recorder('status:tenant').steps, { checkOnly: true })).rejects.toThrow(/status:tenant failed/);
    await expect(runJob(ENV, recorder(undefined, ['t: no RLS']).steps, { checkOnly: true })).rejects.toThrow(/rls:check failed/);
  });

  it('[B-3] the backup verifier is optional with the bootstrap, and refused without it', () => {
    expect(BOOTSTRAP_OPTIONAL).toEqual(['ROLE_VERIFIER_BACKUP']);
    expect(envProblems({ ...WITH_BOOTSTRAP, ROLE_VERIFIER_BACKUP: 'v' })).toEqual([]);
    expect(envProblems({ ...ENV, ROLE_VERIFIER_BACKUP: 'v' })).toEqual(['ROLE_VERIFIER_BACKUP is given without the bootstrap']);
  });
});
