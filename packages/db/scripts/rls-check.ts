/**
 * Static tenant-isolation checker — a CI gate (docs/07 §3.3, docs/12 §3).
 * Fails if any tenant table lacks tenant_id, forced RLS, the tenant_isolation policy,
 * or has a unique constraint / foreign key that does not include tenant_id.
 *
 *   pnpm rls:check
 */
import pg from 'pg';
import { loadRootEnv, requireEnv } from './env.js';

const ALLOWLIST = new Set(['_prisma_migrations']);

async function main() {
  loadRootEnv();
  const client = new pg.Client({ connectionString: requireEnv('TENANT_POOL_01_MIGRATOR_URL') });
  await client.connect();
  const problems: string[] = [];

  const tables = await client.query<{
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

  const checked = tables.rows.filter((t) => !ALLOWLIST.has(t.table));
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

  await client.end();

  if (checked.length === 0) problems.push('no tenant tables found — did migrations run?');
  if (problems.length > 0) {
    console.error(`✗ RLS check failed (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ RLS check passed: ${checked.length} tenant tables isolated, all uniques and FKs tenant-scoped.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
