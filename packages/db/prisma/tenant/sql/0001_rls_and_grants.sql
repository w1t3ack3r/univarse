-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant isolation (docs/07-data-and-database.md §3) — appended to the init migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- The tenant for the current transaction, set by the app with
--   SELECT set_config('app.tenant_id', '<uuid>', true)
-- Unset → NULL → every policy comparison is NULL → no rows (fails closed).
CREATE OR REPLACE FUNCTION univarse_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Enables + FORCES RLS and (re)creates the standard tenant_isolation policy on a table.
-- Every new tenant table MUST be passed through this in its migration.
CREATE OR REPLACE FUNCTION univarse_enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = univarse_current_tenant()) '
    'WITH CHECK (tenant_id = univarse_current_tenant())', tbl);
END
$$;

SELECT univarse_enable_tenant_rls(t::regclass) FROM unnest(ARRAY[
  'org_unit', 'user_account', 'session', 'mfa_factor', 'one_time_token', 'role',
  'role_assignment', 'audit_event', 'outbox_event', 'setting', 'file_object', 'sequence'
]) AS t;

-- Append-only tables: enforced by grants, not convention (docs/07 §1).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM univarse_app;
REVOKE UPDATE, DELETE, TRUNCATE ON outbox_event FROM univarse_app;
GRANT UPDATE (published_at, attempts, last_error) ON outbox_event TO univarse_app;
