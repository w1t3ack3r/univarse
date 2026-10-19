/**
 * The roles, databases and database-level privileges UniVarse needs (docs/07 §1), as a superuser. Idempotent:
 * re-running sets each role's password again and refreshes the privileges. Used by `pnpm db:setup`
 * (scripts/setup-local.ts, with fresh passwords) and by the stack's migrate job (spec 0019 D3, with SCRAM
 * verifiers computed by `pnpm stack:init`: PostgreSQL stores a pre-hashed verifier as given, so the job never sees
 * a plaintext role password). Logs role and database names only.
 */
import type pg from 'pg';

export const ROLES = Object.freeze({
  migrator: 'univarse_migrator',
  app: 'univarse_app',
  appPlatform: 'univarse_app_platform',
  // Spec 0016 IO17: the platform invalidation relay; the worker only. Its table grants are in the migration.
  relayPlatform: 'univarse_relay_platform',
} as const);
export type RoleKey = keyof typeof ROLES;

export const DATABASES = Object.freeze([
  { name: 'univarse_platform', appRole: ROLES.appPlatform, envPrefix: 'PLATFORM' },
  { name: 'univarse_pool_01', appRole: ROLES.app, envPrefix: 'TENANT_POOL_01' },
] as const);

/** The roles the app connects as: the only ones PgBouncer authenticates (the migrator always connects directly). */
export const APP_ROLES: readonly string[] = [ROLES.app, ROLES.appPlatform];
/** The roles PgBouncer authenticates: the app's, and the relay's (its own pool). */
export const POOLED_ROLES: readonly string[] = [...APP_ROLES, ROLES.relayPlatform];

export interface BootstrapOptions {
  /** A superuser connection to the given database (the maintenance database is `postgres`). */
  readonly connect: (database: string) => Promise<pg.Client>;
  /** Each role's password: plaintext, or a SCRAM-SHA-256 verifier. */
  readonly passwords: Readonly<Record<RoleKey, string>>;
  /** CREATEDB for the migrator: LOCAL DEVELOPMENT ONLY (Prisma's shadow database for `migrate dev`). */
  readonly migratorCreatedb: boolean;
  readonly log?: (line: string) => void;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
/** Generated hex passwords or SCRAM verifiers only: nothing that could close the literal. */
const SAFE_SECRET = /^[A-Za-z0-9+/=$:-]{16,512}$/;

export async function bootstrap({ connect, passwords, migratorCreatedb, log = () => undefined }: BootstrapOptions): Promise<void> {
  for (const [key, value] of Object.entries(passwords)) if (!SAFE_SECRET.test(value)) throw new Error(`the ${key} password has an unexpected shape`);
  const admin = await connect('postgres');
  try {
    for (const [key, role] of Object.entries(ROLES) as [RoleKey, string][]) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
      const verb = exists ? 'ALTER' : 'CREATE';
      const createdb = key === 'migrator' && migratorCreatedb ? 'CREATEDB' : 'NOCREATEDB';
      await admin.query(`${verb} ROLE ${ident(role)} WITH LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS ${createdb} PASSWORD '${passwords[key]}'`);
      log(`  ✓ role ${role} ${exists ? '(password set)' : '(created)'}`);
    }
    // Spec 0017 D6: a UTC default for app sessions that send no TimeZone. The client's startup option remains the setting.
    for (const role of APP_ROLES) await admin.query(`ALTER ROLE ${ident(role)} SET timezone = 'UTC'`);
    // Spec 0016 IO11: the relay's transaction limits, server-side, behind its 3 s client timeout.
    for (const setting of ["transaction_timeout = '5s'", "statement_timeout = '5s'", "idle_in_transaction_session_timeout = '5s'", "timezone = 'UTC'"])
      await admin.query(`ALTER ROLE ${ROLES.relayPlatform} SET ${setting}`);
    log(`  ✓ role settings (UTC; ${ROLES.relayPlatform} timeouts 5 s)`);

    for (const db of DATABASES) {
      const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name])).rowCount;
      if (!exists) await admin.query(`CREATE DATABASE ${ident(db.name)} OWNER ${ROLES.migrator} ENCODING 'UTF8' TEMPLATE template0`);
      await admin.query(`REVOKE ALL ON DATABASE ${ident(db.name)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${ident(db.name)} TO ${ident(db.appRole)}`);
      // The relay: CONNECT to the platform database only, and USAGE on its schema (below); no TEMPORARY, nothing else.
      if (db.name === 'univarse_platform') await admin.query(`GRANT CONNECT ON DATABASE ${ident(db.name)} TO ${ROLES.relayPlatform}`);

      const c = await connect(db.name);
      try {
        await c.query(`ALTER SCHEMA public OWNER TO ${ROLES.migrator}`);
        await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
        await c.query(`GRANT USAGE ON SCHEMA public TO ${ident(db.appRole)}`);
        if (db.name === 'univarse_platform') await c.query(`GRANT USAGE ON SCHEMA public TO ${ROLES.relayPlatform}`);
        await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLES.migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(db.appRole)}`);
        await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ROLES.migrator} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(db.appRole)}`);
      } finally {
        await c.end();
      }
      log(`  ✓ database ${db.name} ${exists ? '(exists, privileges refreshed)' : '(created)'}`);
    }
  } finally {
    await admin.end();
  }
}
