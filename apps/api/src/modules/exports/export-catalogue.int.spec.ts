/**
 * Spec 0038 Q-B3 (T35): the export's catalogue covers the tenant database exactly. Every tenant table is exported or
 * left out with a reason; every column of an exported table is written, left out with a reason, or decrypted; and no
 * encrypted value, password, token, code or recovery hash is ever written as it is stored. A new table or column fails
 * here until someone decides which it is.
 */
import { existsSync } from 'node:fs';
import { createTenantShardClient, type TenantShardClient } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXCLUDED_TABLES, EXPORTED_TABLES } from './export-catalogue.js';

const rootEnv = new URL('../../../../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

let shard: TenantShardClient;
let tables: Map<string, Set<string>>;

beforeAll(async () => {
  shard = createTenantShardClient(process.env.TENANT_POOL_01_MIGRATOR_URL!);
  const rows = await shard.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = c.table_name AND k.column_name = 'tenant_id')`;
  tables = new Map();
  for (const r of rows) tables.set(r.table_name, (tables.get(r.table_name) ?? new Set()).add(r.column_name));
});

afterAll(async () => {
  await shard.$disconnect();
});

describe('[Q-B3] the export catalogue', () => {
  it('names every tenant table once: exported, or left out with a reason', () => {
    const exported = EXPORTED_TABLES.map((t) => t.table);
    expect(new Set(exported).size).toBe(exported.length);
    expect([...exported, ...Object.keys(EXCLUDED_TABLES)].sort()).toEqual([...tables.keys()].sort());
    for (const t of exported) expect(Object.keys(EXCLUDED_TABLES)).not.toContain(t);
  });

  it('classifies every column of an exported table: written, left out with a reason, or decrypted', () => {
    for (const t of EXPORTED_TABLES) {
      const db = tables.get(t.table) ?? new Set<string>();
      const decrypted = Object.keys(t.decrypted ?? {});
      const outputs = new Set(decrypted.map((c) => c.replace(/_enc$/, '')));
      const written = t.columns.filter((c) => !outputs.has(c));
      const classified = [...written, ...Object.keys(t.excluded), ...decrypted].sort();
      expect([t.table, classified]).toEqual([t.table, [...db].sort()]);
      // Every decrypted column is written under its plain name.
      for (const o of outputs) expect([t.table, t.columns]).toEqual([t.table, expect.arrayContaining([o])]);
    }
  });

  it('never writes a stored secret: no encrypted value as stored, no hash of a password, token, code or recovery code', () => {
    for (const t of EXPORTED_TABLES) {
      const decrypted = new Set(Object.keys(t.decrypted ?? {}));
      for (const c of t.columns) {
        expect([t.table, c, /_enc$/.test(c)]).toEqual([t.table, c, false]);
        expect([t.table, c, /password|secret|token|code_hash|undo_hash|address_hash/.test(c)]).toEqual([t.table, c, c === 'password_reset_required']);
      }
      for (const c of tables.get(t.table) ?? []) {
        if (/_enc$/.test(c)) expect([t.table, c, decrypted.has(c) || t.excluded[c] === 'secret']).toEqual([t.table, c, true]);
      }
    }
  });
});
