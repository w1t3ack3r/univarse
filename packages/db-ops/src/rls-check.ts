/**
 * Static tenant-isolation checker — a CI gate (docs/07 §3.3, docs/12 §3), and the migrate job's gate (spec 0019).
 * Problems if any tenant table lacks tenant_id, forced RLS, the tenant_isolation policy, or has a unique constraint /
 * foreign key that does not include tenant_id; and, on the platform database, the invalidation capture gate (spec
 * 0016 IO15). Connects as the migrator; reads the catalogue only.
 */
import pg from 'pg';
import { captureGateProblems } from './capture-gate.js';

const ALLOWLIST = new Set(['_prisma_migrations']);

export interface RlsCheckResult {
  readonly problems: string[];
  /** Tenant tables checked. */
  readonly tables: number;
}

export async function rlsCheck(urls: { tenantMigratorUrl: string; platformMigratorUrl: string }): Promise<RlsCheckResult> {
  const client = new pg.Client({ connectionString: urls.tenantMigratorUrl });
  await client.connect();
  const problems: string[] = [];
  let tables: number;
  try {
    const rows = await client.query<{
      table: string;
      rls: boolean;
      forced: boolean;
      has_tenant: boolean;
      has_policy: boolean;
    }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
        EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
        EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS has_policy
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY 1`);

    const checked = rows.rows.filter((t) => !ALLOWLIST.has(t.table));
    tables = checked.length;
    for (const t of checked) {
      if (!t.has_tenant) problems.push(`${t.table}: missing tenant_id column`);
      if (!t.rls) problems.push(`${t.table}: row level security not enabled`);
      if (!t.forced) problems.push(`${t.table}: row level security not FORCED`);
      if (!t.has_policy) problems.push(`${t.table}: missing tenant_isolation policy`);
    }

    // Unique indexes (other than the PK) must lead with tenant_id.
    const uniques = await client.query<{ table: string; index: string }>(`
      SELECT t.relname AS table, i.relname AS index
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND x.indisunique AND NOT x.indisprimary
        AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = x.indkey[0]) IS DISTINCT FROM 'tenant_id'`);
    for (const u of uniques.rows) {
      if (!ALLOWLIST.has(u.table)) problems.push(`${u.table}: unique index ${u.index} does not start with tenant_id`);
    }

    // Foreign keys must include tenant_id on both sides (FK checks bypass RLS).
    const fks = await client.query<{ table: string; constraint: string }>(`
      SELECT t.relname AS table, con.conname AS constraint
      FROM pg_constraint con
      JOIN pg_class t ON t.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND con.contype = 'f'
        AND NOT EXISTS (
          SELECT 1 FROM unnest(con.conkey) k
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
          WHERE a.attname = 'tenant_id')`);
    for (const f of fks.rows) problems.push(`${f.table}: foreign key ${f.constraint} does not include tenant_id`);
  } finally {
    await client.end();
  }

  // Spec 0016 IO15: the platform invalidation capture (triggers, functions, no TEMPORARY), on the platform database.
  const platform = new pg.Client({ connectionString: urls.platformMigratorUrl });
  await platform.connect();
  try {
    problems.push(...(await captureGateProblems(platform)).map((p) => `platform capture: ${p}`));
  } finally {
    await platform.end();
  }

  if (tables === 0) problems.push('no tenant tables found — did migrations run?');
  return { problems, tables };
}
