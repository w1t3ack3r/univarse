/**
 * One-time LOCAL development database setup (docs/07 §1).
 *
 *   pnpm db:setup
 *
 * Connects as a PostgreSQL superuser (password prompted, hidden) and creates:
 *   roles     univarse_migrator (schema owner), univarse_app (tenant data, NOBYPASSRLS),
 *             univarse_app_platform (platform data)
 *   databases univarse_platform, univarse_pool_01 (owned by univarse_migrator)
 * then writes fresh random role passwords into the git-ignored repo-root .env.
 * The app roles get a UTC `timezone` default (spec 0017 D6: a default for sessions that send none; the client's
 * `-c TimeZone=UTC` option stays the setting).
 * For PgBouncer (spec 0017 D2, PB9) it writes the git-ignored .pgbouncer/: the auth_file, holding each app role's
 * SCRAM verifier copied exactly from pg_authid plus a pgbouncer_admin entry (not a PostgreSQL role), owner-only and
 * checked; and the probe and suite profiles' pgbouncer.ini. It logs role names only, never a password or verifier.
 * Re-running rotates the role passwords and regenerates the auth file. Refuses to run against non-local hosts.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';
import { REPO_ROOT, ROOT_ENV_PATH, WORKER_ENV_PATH } from './env.js';
import {
  PGBOUNCER_ADMIN,
  PGBOUNCER_PORT,
  renderAuthFile,
  renderIni,
  scramVerifier,
  writeOwnerOnly,
} from './pgbouncer-config.js';

const host = process.env.PGHOST ?? '127.0.0.1';
const port = Number(process.env.PGPORT ?? 5432);
const superUser = process.env.PGSUPERUSER ?? 'postgres';

const ROLES = {
  migrator: 'univarse_migrator',
  app: 'univarse_app',
  appPlatform: 'univarse_app_platform',
  // Spec 0016 IO17: the platform invalidation relay; the worker only. Its table grants are in the migration.
  relayPlatform: 'univarse_relay_platform',
} as const;
const DATABASES = [
  { name: 'univarse_platform', appRole: ROLES.appPlatform, envPrefix: 'PLATFORM' },
  { name: 'univarse_pool_01', appRole: ROLES.app, envPrefix: 'TENANT_POOL_01' },
] as const;
/** The roles the app connects as: the only ones PgBouncer authenticates (the migrator always connects directly). */
const APP_ROLES = [ROLES.app, ROLES.appPlatform];
/** The roles PgBouncer authenticates: the app's, and the relay's (its own pool, spec 0017's note on 0016). */
const POOLED_ROLES = [...APP_ROLES, ROLES.relayPlatform];
/** Only in .env.worker (IO17): removed from the root .env should an older setup have put them there. */
const WORKER_ONLY_KEYS = ['PLATFORM_RELAY_URL', 'PGBOUNCER_PLATFORM_RELAY_URL'];

async function promptHidden(question: string): Promise<string> {
  if (process.env.PGSUPERPASSWORD) return process.env.PGSUPERPASSWORD;
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Mute echo of typed characters.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
    if (s.startsWith(question)) stdout.write(s);
  };
  const answer = await rl.question(question);
  rl.close();
  stdout.write('\n');
  return answer;
}

const secret = () => randomBytes(24).toString('hex'); // [0-9a-f] only: safe to inline in SQL
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Unsafe identifier ${s}`);
  return s;
};

async function connect(database: string, password: string) {
  const client = new pg.Client({ host, port, user: superUser, password, database });
  await client.connect();
  return client;
}

async function main() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing to run against non-local host "${host}". This script is for local dev only.`);
  }
  console.log(`UniVarse local DB setup → ${superUser}@${host}:${port}`);
  const superPassword = await promptHidden(`Password for PostgreSQL superuser "${superUser}": `);

  const admin = await connect('postgres', superPassword);
  const version = (await admin.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0];
  if (!version || Number(version.server_version_num) < 180000) {
    throw new Error('PostgreSQL 18+ is required (uuidv7()). Set PGPORT to your PG18 instance.');
  }
  // PgBouncer's auth_file needs SCRAM verifiers (PB9): a server hashing new passwords as md5 is refused up front.
  const encryption = (await admin.query<{ password_encryption: string }>('SHOW password_encryption')).rows[0];
  if (encryption?.password_encryption !== 'scram-sha-256') {
    throw new Error(`password_encryption must be scram-sha-256 (it is ${String(encryption?.password_encryption)}).`);
  }

  const passwords = { migrator: secret(), app: secret(), appPlatform: secret(), relayPlatform: secret() };
  for (const [key, role] of Object.entries(ROLES) as [keyof typeof ROLES, string][]) {
    const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
    const verb = exists ? 'ALTER' : 'CREATE';
    // CREATEDB for the migrator is LOCAL ONLY (Prisma shadow DB for `migrate dev`). Never in prod.
    const extra = key === 'migrator' ? 'CREATEDB' : 'NOCREATEDB';
    await admin.query(
      `${verb} ROLE ${ident(role)} WITH LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS ${extra} PASSWORD '${passwords[key]}'`,
    );
    console.log(`  ✓ role ${role} ${exists ? '(password rotated)' : '(created)'}`);
  }
  // D6: a UTC default for app sessions that send no TimeZone. The client's startup option remains the setting.
  for (const role of APP_ROLES) {
    await admin.query(`ALTER ROLE ${ident(role)} SET timezone = 'UTC'`);
    console.log(`  ✓ role ${role} timezone default UTC`);
  }
  // Spec 0016 IO11: the relay's transaction limits, server-side, behind its 3 s client timeout.
  await admin.query(
    `ALTER ROLE ${ROLES.relayPlatform} SET transaction_timeout = '5s'`,
  );
  await admin.query(`ALTER ROLE ${ROLES.relayPlatform} SET statement_timeout = '5s'`);
  await admin.query(`ALTER ROLE ${ROLES.relayPlatform} SET idle_in_transaction_session_timeout = '5s'`);
  await admin.query(`ALTER ROLE ${ROLES.relayPlatform} SET timezone = 'UTC'`);
  console.log(`  ✓ role ${ROLES.relayPlatform} timeouts 5 s (transaction, statement, idle in transaction)`);

  // PB9: copy each app role's verifier exactly as PostgreSQL stored it, under the same name.
  const stored = await admin.query<{ rolname: string; rolpassword: string | null }>(
    'SELECT rolname, rolpassword FROM pg_authid WHERE rolname = ANY($1::text[])',
    [POOLED_ROLES],
  );
  const verifierOf = (role: string) => stored.rows.find((r) => r.rolname === role)?.rolpassword ?? null;
  const adminPassword = secret();
  const authFile = renderAuthFile([
    ...POOLED_ROLES.map((user) => ({ user, verifier: verifierOf(user) })),
    { user: PGBOUNCER_ADMIN, verifier: scramVerifier(adminPassword) },
  ]);

  for (const db of DATABASES) {
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name])).rowCount;
    if (!exists) {
      await admin.query(`CREATE DATABASE ${ident(db.name)} OWNER ${ROLES.migrator} ENCODING 'UTF8' TEMPLATE template0`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${ident(db.name)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(db.name)} TO ${ident(db.appRole)}`);
    // The relay: CONNECT to the platform database only, and USAGE on its schema (below); no TEMPORARY, nothing else.
    if (db.name === 'univarse_platform')
      await admin.query(`GRANT CONNECT ON DATABASE ${ident(db.name)} TO ${ROLES.relayPlatform}`);

    const c = await connect(db.name, superPassword);
    try {
      await c.query(`ALTER SCHEMA public OWNER TO ${ROLES.migrator}`);
      await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await c.query(`GRANT USAGE ON SCHEMA public TO ${ident(db.appRole)}`);
      if (db.name === 'univarse_platform') await c.query(`GRANT USAGE ON SCHEMA public TO ${ROLES.relayPlatform}`);
      await c.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLES.migrator} IN SCHEMA public ` +
          `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(db.appRole)}`,
      );
      await c.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLES.migrator} IN SCHEMA public ` +
          `GRANT USAGE, SELECT ON SEQUENCES TO ${ident(db.appRole)}`,
      );
    } finally {
      await c.end();
    }
    console.log(`  ✓ database ${db.name} ${exists ? '(exists, privileges refreshed)' : '(created)'}`);
  }
  await admin.end();

  writePgBouncerFiles(authFile);

  const url = (user: string, pw: string, dbName: string, at = `${host}:${port}`) =>
    `postgresql://${user}:${pw}@${at}/${dbName}`;
  const bouncer = `127.0.0.1:${PGBOUNCER_PORT}`;
  const generated: Record<string, string> = {};
  for (const db of DATABASES) {
    const appPw = db.appRole === ROLES.app ? passwords.app : passwords.appPlatform;
    generated[`${db.envPrefix}_DATABASE_URL`] = url(db.appRole, appPw, db.name);
    generated[`${db.envPrefix}_MIGRATOR_URL`] = url(ROLES.migrator, passwords.migrator, db.name);
    // Through PgBouncer (spec 0017): app roles only. Migrations, setup, seeding and rls:check stay direct (PB8).
    generated[`PGBOUNCER_${db.envPrefix}_DATABASE_URL`] = url(db.appRole, appPw, db.name, bouncer);
  }
  generated.PGBOUNCER_ADMIN_URL = url(PGBOUNCER_ADMIN, adminPassword, 'pgbouncer', bouncer);
  writeEnv(generated, WORKER_ONLY_KEYS);
  // Spec 0016 IO17: the relay's URLs go to .env.worker only, which only the worker entrypoint loads.
  writeWorkerEnv({
    PLATFORM_RELAY_URL: url(ROLES.relayPlatform, passwords.relayPlatform, 'univarse_platform'),
    PGBOUNCER_PLATFORM_RELAY_URL: url(ROLES.relayPlatform, passwords.relayPlatform, 'univarse_platform', bouncer),
  });
  console.log(`  ✓ wrote the relay's connection strings to ${WORKER_ENV_PATH} (git-ignored, worker only)`);
  console.log(`  ✓ wrote connection strings to ${ROOT_ENV_PATH} (git-ignored)`);
  console.log('\nNext: pnpm db:migrate && pnpm rls:check');
}

/** .pgbouncer/: the owner-only auth file (checked after writing), and the two profiles' pgbouncer.ini. */
function writePgBouncerFiles(authFile: string) {
  const dir = join(REPO_ROOT, '.pgbouncer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const userlist = join(dir, 'userlist.txt');
  // A fresh owner-only file, checked, then renamed over the old one: never widened, never rewritten in place.
  writeOwnerOnly(userlist, authFile);
  console.log(`  ✓ PgBouncer auth file for ${[...POOLED_ROLES, PGBOUNCER_ADMIN].join(', ')} (owner-only, git-ignored)`);
  for (const profile of ['probe', 'suite'] as const) {
    writeFileSync(
      join(dir, `pgbouncer.${profile}.ini`),
      renderIni({ profile, databases: DATABASES.map((d) => d.name), serverPort: port }),
    );
  }
  console.log(`  ✓ PgBouncer probe and suite profiles in ${dir}`);
}

/** The worker's own env file (spec 0016 IO17): the relay's credentials, and nothing else. Replaced whole. */
function writeWorkerEnv(values: Record<string, string>) {
  const lines = [
    '# Generated by pnpm db:setup — the WORKER only (spec 0016 IO17). LOCAL DEVELOPMENT ONLY. Never commit.',
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(WORKER_ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

/** Replaces generated keys in .env, preserving any other lines; `remove` keys are dropped too. */
function writeEnv(values: Record<string, string>, remove: readonly string[] = []) {
  const drop = [...Object.keys(values), ...remove];
  const kept = existsSync(ROOT_ENV_PATH)
    ? readFileSync(ROOT_ENV_PATH, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !drop.some((k) => l.startsWith(`${k}=`)) && !l.startsWith('# Generated by pnpm db:setup'))
    : [];
  const lines = [
    '# Generated by pnpm db:setup — LOCAL DEVELOPMENT ONLY. Never commit.',
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    ...kept,
  ];
  writeFileSync(ROOT_ENV_PATH, lines.join('\n') + '\n', { mode: 0o600 });
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
