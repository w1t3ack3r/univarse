// Spec 0019 D9: the stack's secrets, generated once by `pnpm stack:init` into STACK_DIR/secrets.json, owner-only
// (spec 0017's writeOwnerOnly: a fresh file, checked, renamed in). Never printed; `--rotate` replaces them.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { restrictDirToOwner, scramVerifier, writeOwnerOnly } from '../../../packages/db/scripts/pgbouncer-config.js';
import { STACK_DIR } from './config.js';
import type { StackSecrets } from './render.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** Fresh secrets. Passwords are hex (printable ASCII, URL-safe, SASLprep leaves them unchanged). */
export function generateSecrets(): StackSecrets {
  const roles = { migrator: hex(24), app: hex(24), appPlatform: hex(24), relayPlatform: hex(24) };
  return {
    postgresSuperuser: hex(24),
    roles,
    verifiers: {
      migrator: scramVerifier(roles.migrator),
      app: scramVerifier(roles.app),
      appPlatform: scramVerifier(roles.appPlatform),
      relayPlatform: scramVerifier(roles.relayPlatform),
    },
    ...adminSecrets(),
    sessionPepper: randomBytes(32).toString('base64url'),
    valkeyPassword: hex(24),
    s3AccessKey: `uvstack${hex(8)}`,
    s3SecretKey: randomBytes(30).toString('base64url'),
  };
}

/** B5: PgBouncer's admin console, for `pnpm stack:pools` and the isolation probe only (never an app role). */
function adminSecrets(): Pick<StackSecrets, 'pgbouncerAdminPassword' | 'pgbouncerAdminVerifier'> {
  const pgbouncerAdminPassword = hex(24);
  return { pgbouncerAdminPassword, pgbouncerAdminVerifier: scramVerifier(pgbouncerAdminPassword) };
}

const KEYS: (keyof StackSecrets)[] = ['postgresSuperuser', 'roles', 'verifiers', 'pgbouncerAdminPassword', 'pgbouncerAdminVerifier', 'sessionPepper', 'valkeyPassword', 's3AccessKey', 's3SecretKey'];

/** The stack directory, created owner-only (its DACL replaced on Windows, mode 0700 elsewhere). */
export function ensureStackDir(dir = STACK_DIR): string {
  mkdirSync(dir, { recursive: true });
  restrictDirToOwner(dir);
  return dir;
}

export const secretsFile = (dir = STACK_DIR) => join(dir, 'secrets.json');

export function loadSecrets(dir = STACK_DIR): StackSecrets {
  const file = secretsFile(dir);
  if (!existsSync(file)) throw new Error(`no stack secrets at ${file}: run pnpm stack:init`);
  const s = JSON.parse(readFileSync(file, 'utf8')) as StackSecrets;
  for (const k of KEYS) if (!(k in s)) throw new Error(`${file} has no ${k}: run pnpm stack:init --rotate`);
  return s;
}

/**
 * Writes secrets.json unless it exists (or `rotate`). An existing file missing a secret added since (PR B's admin
 * password) gains only that one, every other value kept, so an upgrade never forces a rotation (and with it a reset of
 * the database, whose superuser password is fixed at its creation). Returns what it did.
 */
export function saveSecrets(s: StackSecrets, { dir = STACK_DIR, rotate = false } = {}): 'written' | 'kept' | 'upgraded' {
  const file = secretsFile(dir);
  if (existsSync(file) && !rotate) {
    const current = JSON.parse(readFileSync(file, 'utf8')) as Partial<StackSecrets>;
    if (current.pgbouncerAdminPassword) return 'kept';
    writeOwnerOnly(file, `${JSON.stringify({ ...current, ...adminSecrets() }, null, 2)}\n`);
    return 'upgraded';
  }
  writeOwnerOnly(file, `${JSON.stringify(s, null, 2)}\n`);
  return 'written';
}

/** Every secret value, for the leak checks (LS9): nothing written outside STACK_DIR, or printed, may contain one. */
export function secretValues(s: StackSecrets): string[] {
  return [s.postgresSuperuser, ...Object.values(s.roles), ...Object.values(s.verifiers), s.pgbouncerAdminPassword, s.pgbouncerAdminVerifier, s.sessionPepper, s.valkeyPassword, s.s3SecretKey];
}
