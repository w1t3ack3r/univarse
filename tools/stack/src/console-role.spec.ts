// Spec 0027 P5: the bootstrap creates the console role with LOGIN and nothing else, CONNECT to the platform database
// only, and only when it is given the role's password.
import { describe, expect, it } from 'vitest';
import { bootstrap, CONSOLE_ROLE, DATABASES } from '../../../packages/db-ops/src/bootstrap.js';

function fakeClient(log: string[], database: string) {
  return {
    query: (sql: string) => {
      log.push(`[${database}] ${sql}`);
      return Promise.resolve({ rowCount: 0, rows: [] });
    },
    end: () => Promise.resolve(),
  };
}

const V = 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk$c2VydmVy';
const passwords = { migrator: V, app: V, appPlatform: V, relayPlatform: V };

async function run(consolePassword?: string) {
  const log: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake with the two methods bootstrap uses
  await bootstrap({ connect: (db) => Promise.resolve(fakeClient(log, db) as any), passwords, migratorCreatedb: false, consolePassword });
  return log;
}

describe('the console role', () => {
  it('is created with LOGIN, and without superuser, role creation, databases, replication or BYPASSRLS', async () => {
    const created = (await run(V)).filter((q) => /(CREATE|ALTER) ROLE univarse_console WITH/.test(q));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/CREATE ROLE univarse_console WITH LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOREPLICATION PASSWORD '/);
  });

  it('gets CONNECT on the platform database, and no other grant anywhere', async () => {
    const grants = (await run(V)).filter((q) => /\b(GRANT|ALTER DEFAULT)\b/.test(q) && q.includes(CONSOLE_ROLE));
    expect(grants).toEqual([`[postgres] GRANT CONNECT ON DATABASE "univarse_platform" TO ${CONSOLE_ROLE}`]);
  });

  it('can reach no tenant database: every other database revokes PUBLIC and grants only its own app role', async () => {
    const log = await run(V);
    for (const db of DATABASES.filter((d) => d.name !== 'univarse_platform')) {
      expect(log).toContain(`[postgres] REVOKE ALL ON DATABASE "${db.name}" FROM PUBLIC`);
      expect(log.filter((q) => q.includes(`ON DATABASE "${db.name}"`) && q.startsWith('[postgres] GRANT'))).toEqual([`[postgres] GRANT CONNECT ON DATABASE "${db.name}" TO "${db.appRole}"`]);
    }
  });

  it('is neither created nor granted anything without its password', async () => {
    expect((await run()).some((q) => q.includes(CONSOLE_ROLE))).toBe(false);
  });

  it('refuses a password that could close the SQL literal', async () => {
    await expect(run("x' SUPERUSER --aaaaaaaaaaa")).rejects.toThrow(/console password has an unexpected shape/);
  });
});
