-- Spec 0039 PR C (S8): placement by level, as the owner changed Q7 on 2026-11-24, and shard health (Q11).
--   claim_ready_shard()  the console's create request claims a READY dedicated database in its own transaction.
--   place_tenant         a tenant goes only onto an ACTIVE shard with room, and its tier follows the shard's kind.
--   shard_health         the worker's check of each shard, once a minute, for the console.
-- Wrapped in one transaction (Q-A3): Prisma doesn't roll a failed PostgreSQL migration back by itself.
BEGIN;

-- Q7 (changed): one statement, so two requests never claim the same database. SKIP LOCKED passes over one another
-- transaction is claiming. NULL when none is ready. Definer: the console's role may not write `shard` itself.
CREATE FUNCTION public.claim_ready_shard() RETURNS uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE public.shard SET status = 'ACTIVE'::public."ShardStatus", status_changed_at = now()
  WHERE id = (
    SELECT s.id FROM public.shard s
    WHERE s.kind = 'DEDICATED'::public."ShardKind" AND s.status = 'READY'::public."ShardStatus"
    ORDER BY s.status_changed_at, s.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id
$$;
REVOKE ALL ON FUNCTION public.claim_ready_shard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ready_shard() TO univarse_console;

-- Q7: the shard row is locked, so two placements on one pool are counted one after the other. A shard that isn't
-- ACTIVE takes no one (a ready one is claimed first; maintenance and retired take no one). A pool takes up to its
-- capacity of institutions not purged; a dedicated database takes one, ever. These hold for every login but the
-- migrator's: it owns the schema (it could drop this trigger), and the tests' scratch shards are its. The tier is the
-- shard's kind, for every login. Definer: it locks a row of `shard`, which no runtime role may update; so the login is
-- session_user (current_user is the function's owner here).
CREATE FUNCTION public.place_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s record;
  held integer;
BEGIN
  IF session_user <> 'univarse_migrator' AND (TG_OP = 'INSERT' OR NEW.shard_id IS DISTINCT FROM OLD.shard_id) THEN
    SELECT id, kind, status, capacity INTO s FROM public.shard WHERE id = NEW.shard_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN NEW; -- tenant_shard_id_fkey refuses it
    END IF;
    IF s.status <> 'ACTIVE'::public."ShardStatus" THEN
      RAISE EXCEPTION 'tenant_shard_not_open: the shard is %', s.status USING ERRCODE = 'check_violation';
    END IF;
    IF s.kind = 'DEDICATED'::public."ShardKind" THEN
      SELECT count(*) INTO held FROM public.tenant WHERE shard_id = s.id AND id <> NEW.id;
    ELSE
      SELECT count(*) INTO held FROM public.tenant
      WHERE shard_id = s.id AND id <> NEW.id AND status <> 'PURGED'::public."TenantStatus";
    END IF;
    IF held >= s.capacity THEN
      RAISE EXCEPTION 'tenant_shard_full: the shard holds % of %', held, s.capacity USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT kind INTO s FROM public.shard WHERE id = NEW.shard_id;
  END IF;
  NEW.tier := CASE WHEN s.kind = 'DEDICATED'::public."ShardKind" THEN 'DEDICATED'::public."TenantTier" ELSE 'POOLED'::public."TenantTier" END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.place_tenant() FROM PUBLIC;
CREATE TRIGGER tenant_place BEFORE INSERT OR UPDATE OF shard_id, tier ON public.tenant
  FOR EACH ROW EXECUTE FUNCTION public.place_tenant();
-- As the capture's triggers: it fires even under session_replication_role = replica (the capture gate checks it).
ALTER TABLE public.tenant ENABLE ALWAYS TRIGGER tenant_place;

-- Q11: one row per shard, the last check. A fixed code, never a driver's message (it can carry a host).
CREATE TABLE "shard_health" (
    "shard_id" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "latency_ms" INTEGER,
    "last_success_at" TIMESTAMPTZ(3),
    "error_code" TEXT,

    CONSTRAINT "shard_health_pkey" PRIMARY KEY ("shard_id"),
    CONSTRAINT "shard_health_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
    CONSTRAINT "shard_health_result_check" CHECK (
      ("ok" AND "error_code" IS NULL AND "latency_ms" IS NOT NULL AND "last_success_at" IS NOT NULL)
      OR (NOT "ok" AND "error_code" IN ('unreachable', 'timeout', 'no_credentials', 'unexpected'))
    )
);
ALTER TABLE "shard_health" ADD CONSTRAINT "shard_health_shard_id_fkey" FOREIGN KEY ("shard_id") REFERENCES "shard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The worker writes the checks; the console reads them (PR D's page). Neither gains anything on `shard`. The default
-- privileges' full grant to the app's role is replaced by exactly this; no row is ever deleted by it.
REVOKE ALL ON public.shard_health FROM univarse_app_platform;
GRANT SELECT, INSERT, UPDATE (checked_at, ok, latency_ms, last_success_at, error_code) ON public.shard_health TO univarse_app_platform;
GRANT SELECT ON public.shard_health TO univarse_console;

COMMIT;
