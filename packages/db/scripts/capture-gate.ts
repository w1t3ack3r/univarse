/**
 * Spec 0016 IO15: the platform invalidation capture can't silently change. Part of `pnpm rls:check` (a CI gate).
 * On the platform database, it fails unless:
 *   • the 9 triggers exist and are ENABLE ALWAYS (tgenabled = 'A'), so session_replication_role = replica can't
 *     skip them: on each cached table its capture and TRUNCATE triggers; on the event table its update guard,
 *     delete guard and TRUNCATE trigger;
 *   • the SECURITY DEFINER functions (capture, purge) are owned by the migrator, with search_path exactly
 *     `pg_catalog, pg_temp`; and no function of the capture has EXECUTE for PUBLIC;
 *   • neither the app role nor the relay role has TEMPORARY on the platform database.
 *   • the database's maximum TTL (cache_invalidation_max_ttl()) still equals MAX_TENANT_CACHE_TTL_MS, so a test
 *     that shortens it and dies before restoring it is caught.
 * Its own mutation checks (disabling or dropping a trigger, PUBLIC EXECUTE, a changed search_path, TEMPORARY) are
 * in packages/db/test/cache-invalidation.int.spec.ts.
 */
import { MAX_TENANT_CACHE_TTL_MS } from '@univarse/contracts';
import type pg from 'pg';

export const CAPTURE_TRIGGERS: readonly [table: string, trigger: string][] = [
  ['tenant', 'tenant_capture_cache_invalidation'],
  ['tenant_domain', 'tenant_domain_capture_cache_invalidation'],
  ['tenant_product', 'tenant_product_capture_cache_invalidation'],
  ['tenant', 'tenant_refuse_truncate'],
  ['tenant_domain', 'tenant_domain_refuse_truncate'],
  ['tenant_product', 'tenant_product_refuse_truncate'],
  ['cache_invalidation_event', 'cache_invalidation_event_guard_update'],
  ['cache_invalidation_event', 'cache_invalidation_event_guard_delete'],
  ['cache_invalidation_event', 'cache_invalidation_event_refuse_truncate'],
];
export const DEFINER_FUNCTIONS = [
  'capture_cache_invalidation',
  'purge_settled_invalidation_events',
];
export const CAPTURE_FUNCTIONS = [
  ...DEFINER_FUNCTIONS,
  'cache_invalidation_max_ttl',
  'refuse_cache_table_truncate',
  'guard_cache_invalidation_event_update',
  'guard_cache_invalidation_event_delete',
];
const NO_TEMPORARY = ['univarse_app_platform', 'univarse_relay_platform'];
const MIGRATOR = 'univarse_migrator';

/** The gate's problems on the platform database (empty when it passes). */
export async function captureGateProblems(client: pg.Client): Promise<string[]> {
  const problems: string[] = [];

  const triggers = await client.query<{ table: string; trigger: string; enabled: string }>(`
    SELECT c.relname AS table, t.tgname AS trigger, t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
  for (const [table, trigger] of CAPTURE_TRIGGERS) {
    const found = triggers.rows.find((r) => r.table === table && r.trigger === trigger);
    if (!found) problems.push(`trigger ${trigger} on ${table} is missing`);
    else if (found.enabled !== 'A')
      problems.push(
        `trigger ${trigger} on ${table} is not ENABLE ALWAYS (tgenabled = '${found.enabled}')`,
      );
  }

  const functions = await client.query<{
    name: string;
    definer: boolean;
    owner: string;
    config: string[] | null;
    public_execute: boolean;
  }>(
    `SELECT p.proname AS name, p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner, p.proconfig AS config,
       -- A NULL ACL means the default: EXECUTE for PUBLIC.
       (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
         AS public_execute
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [CAPTURE_FUNCTIONS],
  );
  for (const name of CAPTURE_FUNCTIONS) {
    const f = functions.rows.find((r) => r.name === name);
    if (!f) {
      problems.push(`function ${name} is missing`);
      continue;
    }
    if (f.public_execute) problems.push(`function ${name} is executable by PUBLIC`);
    const searchPath = (f.config ?? []).find((c) => c.startsWith('search_path='));
    if (searchPath !== 'search_path=pg_catalog, pg_temp')
      problems.push(
        `function ${name} has ${searchPath ?? 'no search_path'}, expected search_path=pg_catalog, pg_temp`,
      );
    if (DEFINER_FUNCTIONS.includes(name)) {
      if (!f.definer) problems.push(`function ${name} is not SECURITY DEFINER`);
      if (f.owner !== MIGRATOR)
        problems.push(`function ${name} is owned by ${f.owner}, expected ${MIGRATOR}`);
    }
  }

  const temps = await client.query<{ role: string; temp: boolean }>(
    `SELECT r.rolname AS role, has_database_privilege(r.rolname, current_database(), 'TEMPORARY') AS temp
     FROM pg_roles r WHERE r.rolname = ANY($1::text[])`,
    [NO_TEMPORARY],
  );
  for (const role of NO_TEMPORARY) {
    const r = temps.rows.find((x) => x.role === role);
    if (!r) problems.push(`role ${role} is missing`);
    else if (r.temp)
      problems.push(`role ${role} may create TEMPORARY tables on the platform database`);
  }
  if (functions.rows.some((r) => r.name === 'cache_invalidation_max_ttl')) {
    const ttl = await client.query<{ ms: string }>(
      `SELECT (extract(epoch FROM public.cache_invalidation_max_ttl()) * 1000)::bigint::text AS ms`,
    );
    const ms = ttl.rows[0]?.ms;
    if (ms !== String(MAX_TENANT_CACHE_TTL_MS))
      problems.push(
        `cache_invalidation_max_ttl() is ${ms ?? 'unreadable'} ms, expected ${String(MAX_TENANT_CACHE_TTL_MS)} (MAX_TENANT_CACHE_TTL_MS)`,
      );
  }
  return problems;
}
