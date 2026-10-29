// Spec 0019 D3/LS4: the migrate image does its job, hardened. Against a disposable PostgreSQL 18 on an internal
// network of its own, it runs twice: the first bootstraps roles and databases from nothing, migrates both schemas,
// passes rls:check, seeds and creates the tenant data keys; the second changes nothing (idempotent). Used by the
// release and by CI.
//   node tools/images/migrate-smoke.mjs <image>
// Secrets are generated here and reach the containers only by environment (`-e NAME`), never on a command line;
// the output is checked for each of them. The key provider is `local` (NODE_ENV=test): the image's production
// default refuses it, which the stack relies on; this smoke has no Vault.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sh } from './release-lib.mjs';

/** postgres:18, pinned (the stack pins the same digest). */
export const POSTGRES_IMAGE = 'postgres:18@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336';
const HARDENED = ['--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'];
const DOMAIN = 'smoke.univarse.localhost';

/** What a pair of runs must show, as a list of problems (empty: it passed). Pure, for the unit tests. */
export function smokeProblems(first, second, secrets) {
  const problems = [];
  const needs = [
    [first, 'first', /\[migrate\] bootstrap: roles, databases, privileges/],
    [first, 'first', /role univarse_relay_platform \(created\)/],
    [first, 'first', /rls:check passed: \d+ tenant tables isolated/],
    [first, 'first', /created data key v1 for demo-uni/],
    [first, 'first', /\[migrate\] done/],
    [second, 'second', /No pending migrations to apply/],
    [second, 'second', /kept {4}data key v1 for demo-uni/],
    [second, 'second', /\[migrate\] done/],
  ];
  for (const [run, name, re] of needs) if (run.status !== 0 || !re.test(run.output)) problems.push(`${name} run: expected ${re} (exit ${String(run.status)})`);
  for (const [name, value] of Object.entries(secrets))
    if (first.output.includes(value) || second.output.includes(value)) problems.push(`the output contains ${name}`);
  return problems;
}

export function migrateSmoke(image) {
  const id = randomBytes(4).toString('hex');
  const net = `uv-migrate-smoke-${id}`;
  const pg = `uv-migrate-smoke-pg-${id}`;
  const hex = () => randomBytes(24).toString('hex');
  const secrets = { superuser: hex(), roles: hex(), kek: randomBytes(32).toString('base64') };
  const at = (user, db) => `postgresql://${user}:${secrets.roles}@${pg}:5432/${db}`;
  const env = {
    POSTGRES_PASSWORD: secrets.superuser,
    BOOTSTRAP_SUPERUSER_URL: `postgresql://postgres:${secrets.superuser}@${pg}:5432/postgres`,
    // bootstrap accepts a password as well as a SCRAM verifier; the stack passes verifiers.
    ROLE_VERIFIER_MIGRATOR: secrets.roles,
    ROLE_VERIFIER_APP: secrets.roles,
    ROLE_VERIFIER_APP_PLATFORM: secrets.roles,
    ROLE_VERIFIER_RELAY_PLATFORM: secrets.roles,
    PLATFORM_MIGRATOR_URL: at('univarse_migrator', 'univarse_platform'),
    TENANT_POOL_01_MIGRATOR_URL: at('univarse_migrator', 'univarse_pool_01'),
    PLATFORM_DATABASE_URL: at('univarse_app_platform', 'univarse_platform'),
    TENANT_POOL_01_DATABASE_URL: at('univarse_app', 'univarse_pool_01'),
    SEED_DOMAIN: DOMAIN,
    NODE_ENV: 'test',
    KEY_PROVIDER: 'local',
    LOCAL_KEK: secrets.kek,
  };
  const jobVars = Object.keys(env).filter((k) => k !== 'POSTGRES_PASSWORD');
  const run = () => {
    const r = sh('docker', ['run', '--rm', '--network', net, ...HARDENED, ...jobVars.flatMap((k) => ['-e', k]), image], { env, allowFail: true });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
  };
  try {
    sh('docker', ['network', 'create', '--internal', net]);
    sh('docker', ['run', '-d', '--name', pg, '--network', net, '-e', 'POSTGRES_PASSWORD', POSTGRES_IMAGE], { env });
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      ready = sh('docker', ['exec', pg, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { allowFail: true }).status === 0;
      if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // a synchronous 1 s pause
    }
    if (!ready) return { ok: false, problems: ['PostgreSQL did not become ready'] };
    const first = run();
    const second = run();
    const domains = sh('docker', ['exec', pg, 'psql', '-U', 'postgres', '-d', 'univarse_platform', '-Atc', 'SELECT hostname FROM tenant_domain ORDER BY 1'], { allowFail: true }).stdout.trim().split('\n');
    const problems = smokeProblems(first, second, secrets);
    if (domains.length !== 3 || !domains.every((d) => d.endsWith(`.${DOMAIN}`))) problems.push(`seeded domains are not the three on ${DOMAIN}: ${domains.join(', ')}`);
    return { ok: problems.length === 0, problems, first, second };
  } finally {
    sh('docker', ['rm', '-f', '-v', pg], { allowFail: true });
    sh('docker', ['network', 'rm', net], { allowFail: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const image = process.argv[2];
  if (!image) {
    console.error('usage: node tools/images/migrate-smoke.mjs <image>');
    process.exit(2);
  }
  const r = migrateSmoke(image);
  if (!r.ok) {
    console.error(`[migrate-smoke] FAILED:\n  ${r.problems.join('\n  ')}`);
    if (r.first) console.error(`--- first run ---\n${r.first.output}\n--- second run ---\n${r.second.output}`);
    process.exit(1);
  }
  console.log(`[migrate-smoke] PASS: ${image} bootstrapped, migrated, checked, seeded and keyed a fresh database hardened, then re-ran with no change`);
}
