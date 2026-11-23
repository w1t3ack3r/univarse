// Spec 0019 LS4, spec 0039 Q9: the migrate job runs its steps in order, stops at a platform failure, goes on past a
// failed shard, and names variables, never their values.
import { describe, expect, it } from 'vitest';
import { BOOTSTRAP, BOOTSTRAP_OPTIONAL, envProblems, runJob, SEED_SHARD, type JobEnv, type JobSteps } from './job.js';
import type { ShardsResult } from './shards.js';

const SECRET = 'not-a-real-password-0123456789';
const ENV: JobEnv = {
  PLATFORM_MIGRATOR_URL: `postgresql://univarse_migrator:${SECRET}@postgres:5432/univarse_platform`,
  TENANT_POOL_01_MIGRATOR_URL: `postgresql://univarse_migrator:${SECRET}@postgres:5432/univarse_pool_01`,
  PLATFORM_DATABASE_URL: `postgresql://univarse_app_platform:${SECRET}@postgres:5432/univarse_platform`,
  TENANT_POOL_01_DATABASE_URL: `postgresql://univarse_app:${SECRET}@postgres:5432/univarse_pool_01`,
  SEED_DOMAIN: 'stack.univarse.localhost',
};
/** ENV as the stack renders it: every URL verifies PostgreSQL against the stack CA (D7). */
const VERIFIED: JobEnv = Object.fromEntries(Object.entries(ENV).map(([k, v]) => [k, k.endsWith('_URL') ? `${v ?? ''}?sslmode=verify-full&sslrootcert=/ca/ca.crt` : v]));
const WITH_BOOTSTRAP: JobEnv = {
  ...ENV,
  BOOTSTRAP_SUPERUSER_URL: `postgresql://postgres:${SECRET}@postgres:5432/postgres`,
  ROLE_VERIFIER_MIGRATOR: 'SCRAM-SHA-256$4096:a$b:c',
  ROLE_VERIFIER_APP: 'SCRAM-SHA-256$4096:a$b:c',
  ROLE_VERIFIER_APP_PLATFORM: 'SCRAM-SHA-256$4096:a$b:c',
  ROLE_VERIFIER_RELAY_PLATFORM: 'SCRAM-SHA-256$4096:a$b:c',
};

function recorder(fail?: string, opts: { shardProblems?: string[]; shards?: ShardsResult } = {}) {
  const calls: string[] = [];
  const step = (name: string) => {
    calls.push(name);
    return name === fail ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
  };
  const steps: JobSteps = {
    bootstrap: () => step('bootstrap'),
    migratePlatform: () => step('migrate:platform'),
    migrateShards: async () => (await step('migrate:shards'), opts.shards ?? { migrated: [SEED_SHARD], failed: [] }),
    status: (which) => step(`status:${which}`),
    checkShards: async () => (await step('checkShards'), opts.shardProblems ?? []),
    seed: () => step('seed'),
    provisionKeys: () => step('provisionKeys'),
    log: () => undefined,
  };
  return { calls, steps };
}

describe('[LS4] the migrate job', () => {
  it('[LS4] runs bootstrap, the platform, every shard, the seed and the keys, in that order', async () => {
    const r = recorder();
    expect(await runJob(WITH_BOOTSTRAP, r.steps)).toEqual({ failedShards: [] });
    expect(r.calls).toEqual(['bootstrap', 'migrate:platform', 'migrate:shards', 'seed', 'provisionKeys']);
  });

  it('[LS4] skips bootstrap when no superuser is given', async () => {
    const r = recorder();
    await runJob(ENV, r.steps);
    expect(r.calls[0]).toBe('migrate:platform');
  });

  it('[spec 0039 Q9] a platform failure stops the job: no shard, seed or key runs', async () => {
    const r = recorder('migrate:platform');
    await expect(runJob(WITH_BOOTSTRAP, r.steps)).rejects.toThrow('migrate:platform failed');
    expect(r.calls).toEqual(['bootstrap', 'migrate:platform']);
  });

  it('[spec 0039 Q9] a failed shard doesn’t stop the job: the seed and the keys run, and it is reported', async () => {
    const r = recorder(undefined, { shards: { migrated: [SEED_SHARD], failed: [{ name: 't-abc', code: 'migrate_failed' }] } });
    expect(await runJob(ENV, r.steps)).toEqual({ failedShards: [{ name: 't-abc', code: 'migrate_failed' }] });
    expect(r.calls).toEqual(['migrate:platform', 'migrate:shards', 'seed', 'provisionKeys']);
  });

  it('[spec 0039 Q9] the seed is skipped when its own pool is in maintenance; the keys still run', async () => {
    const r = recorder(undefined, { shards: { migrated: [], failed: [{ name: SEED_SHARD, code: 'rls_failed' }] } });
    expect(await runJob(ENV, r.steps)).toEqual({ failedShards: [{ name: SEED_SHARD, code: 'rls_failed' }] });
    expect(r.calls).toEqual(['migrate:platform', 'migrate:shards', 'provisionKeys']);
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
    const plain = { ...VERIFIED, NODE_ENV: 'production', KEY_PROVIDER: 'vault', VAULT_ADDR: 'http://127.0.0.1:8200' };
    expect(envProblems(plain)).toEqual([expect.stringMatching(/VAULT_ADDR must be https:\/\/ in production/)]);
    const { steps, calls } = recorder();
    await expect(runJob(plain, steps)).rejects.toThrow(/VAULT_ADDR must be https/);
    expect(calls).toEqual([]);
    expect(envProblems({ ...plain, VAULT_ADDR: 'https://vault:8200' })).toEqual([]);
    expect(envProblems({ ...plain, NODE_ENV: 'development' })).toEqual([]);
  });

  it('[D7] in production every URL must verify PostgreSQL (verify-full with sslrootcert), refused before any step, naming no value', async () => {
    const prod = { ...VERIFIED, NODE_ENV: 'production', KEY_PROVIDER: 'vault', VAULT_ADDR: 'https://vault:8200' };
    expect(envProblems(prod)).toEqual([]);
    for (const k of ['PLATFORM_MIGRATOR_URL', 'TENANT_POOL_01_MIGRATOR_URL', 'PLATFORM_DATABASE_URL', 'TENANT_POOL_01_DATABASE_URL']) {
      const base = ENV[k] ?? '';
      for (const weak of [base, `${base}?sslmode=require`, `${base}?sslmode=verify-full`, `${base}?sslmode=verify-ca&sslrootcert=/ca/ca.crt`]) {
        const problems = envProblems({ ...prod, [k]: weak });
        expect(problems).toEqual([`${k} must say sslmode=verify-full with sslrootcert in production`]);
        expect(problems.join('\n')).not.toContain(SECRET);
      }
    }
    const bootstrapPlain = { ...prod, ...Object.fromEntries(BOOTSTRAP.map((k) => [k, WITH_BOOTSTRAP[k]])) };
    expect(envProblems(bootstrapPlain)).toEqual(['BOOTSTRAP_SUPERUSER_URL must say sslmode=verify-full with sslrootcert in production']);
    const { steps, calls } = recorder();
    await expect(runJob({ ...prod, PLATFORM_MIGRATOR_URL: ENV.PLATFORM_MIGRATOR_URL }, steps)).rejects.toThrow(/PLATFORM_MIGRATOR_URL must say sslmode=verify-full/);
    expect(calls).toEqual([]);
    // Outside production (the image's smoke, against a disposable plaintext database) a URL without TLS settings passes.
    expect(envProblems({ ...ENV, NODE_ENV: 'test' })).toEqual([]);
  });

  it('[B-14] --check-only checks the platform’s status and every shard, and changes nothing, even given the bootstrap', async () => {
    const { calls, steps } = recorder();
    expect(await runJob({ ...WITH_BOOTSTRAP, ROLE_VERIFIER_BACKUP: 'SCRAM-SHA-256$4096:a$b:c' }, steps, { checkOnly: true })).toEqual({ failedShards: [] });
    expect(calls).toEqual(['status:platform', 'checkShards']);
  });

  it('[B-14] --check-only fails on the platform’s pending migration, and on any shard’s problem', async () => {
    await expect(runJob(ENV, recorder('status:platform').steps, { checkOnly: true })).rejects.toThrow(/status:platform failed/);
    await expect(runJob(ENV, recorder(undefined, { shardProblems: ['pool-01: t: no RLS'] }).steps, { checkOnly: true })).rejects.toThrow(/check-only failed \(1 problem\(s\)\):\n {2}pool-01: t: no RLS/);
  });

  it('[B-3] the backup verifier is optional with the bootstrap, and refused without it', () => {
    expect(BOOTSTRAP_OPTIONAL).toEqual(['ROLE_VERIFIER_BACKUP', 'ROLE_VERIFIER_CONSOLE']);
    expect(envProblems({ ...WITH_BOOTSTRAP, ROLE_VERIFIER_BACKUP: 'v' })).toEqual([]);
    expect(envProblems({ ...ENV, ROLE_VERIFIER_BACKUP: 'v' })).toEqual(['ROLE_VERIFIER_BACKUP is given without the bootstrap']);
  });

  it('[spec 0027 P5] the console verifier is optional with the bootstrap, and refused without it', () => {
    expect(BOOTSTRAP_OPTIONAL).toContain('ROLE_VERIFIER_CONSOLE');
    expect(envProblems({ ...WITH_BOOTSTRAP, ROLE_VERIFIER_CONSOLE: 'v' })).toEqual([]);
    expect(envProblems({ ...ENV, ROLE_VERIFIER_CONSOLE: 'v' })).toEqual(['ROLE_VERIFIER_CONSOLE is given without the bootstrap']);
  });
});
