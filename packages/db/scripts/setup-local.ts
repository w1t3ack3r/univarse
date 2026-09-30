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
 * Re-running rotates the role passwords. Refuses to run against non-local hosts.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pg from 'pg';
import { ROOT_ENV_PATH } from './env.js';

const host = process.env.PGHOST ?? '127.0.0.1';
const port = Number(process.env.PGPORT ?? 5432);
const superUser = process.env.PGSUPERUSER ?? 'postgres';

const ROLES = {
  migrator: 'univarse_migrator',
  app: 'univarse_app',
  appPlatform: 'univarse_app_platform',
} as const;
const DATABASES = [
  { name: 'univarse_platform', appRole: ROLES.appPlatform, envPrefix: 'PLATFORM' },
  { name: 'univarse_pool_01', appRole: ROLES.app, envPrefix: 'TENANT_POOL_01' },
] as const;

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
  const version = (await admin.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]!;
  if (Number(version.server_version_num) < 180000) {
    throw new Error('PostgreSQL 18+ is required (uuidv7()). Set PGPORT to your PG18 instance.');
  }

  const passwords = { migrator: secret(), app: secret(), appPlatform: secret() };
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

  for (const db of DATABASES) {
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name])).rowCount;
    if (!exists) {
      await admin.query(`CREATE DATABASE ${ident(db.name)} OWNER ${ROLES.migrator} ENCODING 'UTF8' TEMPLATE template0`);
    }
    await admin.query(`REVOKE ALL ON DATABASE ${ident(db.name)} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${ident(db.name)} TO ${ident(db.appRole)}`);

    const c = await connect(db.name, superPassword);
    try {
      await c.query(`ALTER SCHEMA public OWNER TO ${ROLES.migrator}`);
      await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await c.query(`GRANT USAGE ON SCHEMA public TO ${ident(db.appRole)}`);
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

  const url = (user: string, pw: string, dbName: string) =>
    `postgresql://${user}:${pw}@${host}:${port}/${dbName}`;
  const generated: Record<string, string> = {};
  for (const db of DATABASES) {
    const appPw = db.appRole === ROLES.app ? passwords.app : passwords.appPlatform;
    generated[`${db.envPrefix}_DATABASE_URL`] = url(db.appRole, appPw, db.name);
    generated[`${db.envPrefix}_MIGRATOR_URL`] = url(ROLES.migrator, passwords.migrator, db.name);
  }
  writeEnv(generated);
  console.log(`  ✓ wrote connection strings to ${ROOT_ENV_PATH} (git-ignored)`);
  console.log('\nNext: pnpm db:migrate && pnpm rls:check');
}

/** Replaces generated keys in .env, preserving any other lines. */
function writeEnv(values: Record<string, string>) {
  const kept = existsSync(ROOT_ENV_PATH)
    ? readFileSync(ROOT_ENV_PATH, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !Object.keys(values).some((k) => l.startsWith(`${k}=`)) && !l.startsWith('# Generated by pnpm db:setup'))
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
