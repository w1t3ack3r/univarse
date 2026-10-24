// Spec 0020 B-3: the migrate job's bootstrap creates the backup role with REPLICATION and nothing else, and only when
// it is given the role's verifier.
import { describe, expect, it } from 'vitest';
import { bootstrap, BACKUP_ROLE } from '../../../../packages/db-ops/src/bootstrap.js';

function fakeClient(log: string[]) {
  return {
    query: (sql: string) => {
      log.push(sql);
      return Promise.resolve({ rowCount: 0, rows: [] });
    },
    end: () => Promise.resolve(),
  };
}

const V = 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk$c2VydmVy';
const passwords = { migrator: V, app: V, appPlatform: V, relayPlatform: V };

async function run(backupPassword?: string) {
  const log: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake with the two methods bootstrap uses
  await bootstrap({ connect: () => Promise.resolve(fakeClient(log) as any), passwords, migratorCreatedb: false, backupPassword });
  return log;
}

describe('the backup role', () => {
  it('is created with LOGIN REPLICATION, and without superuser, role creation, databases or BYPASSRLS', async () => {
    const sql = (await run(V)).filter((q) => q.includes(BACKUP_ROLE));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toMatch(/^CREATE ROLE univarse_backup WITH LOGIN REPLICATION NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD '/);
  });

  it('gets no grant on any database or object', async () => {
    for (const q of await run(V)) if (/^(GRANT|ALTER DEFAULT)/.test(q)) expect(q).not.toContain(BACKUP_ROLE);
  });

  it('is neither created nor changed without its verifier (pnpm db:setup)', async () => {
    expect((await run()).some((q) => q.includes(BACKUP_ROLE))).toBe(false);
  });

  it('refuses a verifier that could close the SQL literal', async () => {
    await expect(run("x' SUPERUSER --aaaaaaaaaaa")).rejects.toThrow(/backup password has an unexpected shape/);
  });
});
