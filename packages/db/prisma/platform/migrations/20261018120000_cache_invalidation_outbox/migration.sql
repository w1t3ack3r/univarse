-- Spec 0016 (ADR-031): the platform invalidation outbox. A trigger on each cached platform table writes an
-- invalidation event in the SAME transaction as the change, so any writer is covered (the API, the seed, a
-- migration, psql, a stored function, dynamic SQL); a relay in the worker publishes committed events to the bus.
-- Expand-only. The relay role (univarse_relay_platform) is created by `pnpm db:setup`, which runs before migrations.

-- D6: the shared maximum cache TTL, in milliseconds. Equals MAX_TENANT_CACHE_TTL_MS in @univarse/contracts
-- (a unit test reads this line). Expiry waits for first observation + this + 5 s.
CREATE FUNCTION public.cache_invalidation_max_ttl() RETURNS interval
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT interval '60000 milliseconds' $$;

-- The events: a channel, a tenant id, a source label and bookkeeping. Never row values (IO14).
CREATE TABLE public.cache_invalidation_event (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  channel            text NOT NULL CHECK (channel IN ('uv:tenants:invalidate', 'uv:products:invalidate')),
  tenant_id          uuid NOT NULL,        -- no FK: the tenant may have just been deleted
  source             text NOT NULL,        -- e.g. 'tenant_product:UPDATE'
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),  -- diagnostics only; never used for expiry
  first_observed_at  timestamptz,          -- stamped by the update guard: clock_timestamp() at first claim
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz NOT NULL DEFAULT clock_timestamp(),  -- finite: fresh events never outrank due retries
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'EXPIRED')),
  settled_at         timestamptz,          -- stamped by the update guard on settlement
  last_error         text                  -- an error class only (spec 0002 B9)
);
CREATE INDEX cache_invalidation_event_due ON public.cache_invalidation_event (next_attempt_at, id) WHERE status = 'PENDING';
CREATE INDEX cache_invalidation_event_settled ON public.cache_invalidation_event (settled_at) WHERE status <> 'PENDING';

-- Capture (IO1, IO2, IO4, IO5): one function for the three tables; the channel is the trigger's argument.
-- SECURITY DEFINER (owned by the migrator, which runs this migration), so writers need no privilege on the event
-- table; search_path fixed with pg_temp last, and every reference schema-qualified (IO16).
CREATE FUNCTION public.capture_cache_invalidation() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_channel text := TG_ARGV[0];
  v_source text := TG_TABLE_NAME || ':' || TG_OP;
  v_old uuid;
  v_new uuid;
BEGIN
  -- A no-op UPDATE emits nothing. Checked here: a combined trigger's WHEN can't use OLD and NEW.
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NULL;
  END IF;
  -- The tenant id is `id` on tenant and `tenant_id` on the others. Separate statements: PL/pgSQL plans each one
  -- only when it runs, so the other table's field is never referenced.
  IF TG_TABLE_NAME = 'tenant' THEN
    IF TG_OP <> 'INSERT' THEN v_old := OLD.id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := NEW.id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN v_old := OLD.tenant_id; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := NEW.tenant_id; END IF;
  END IF;
  -- An ownership change names the old AND the new tenant (IO4); otherwise the tenant once.
  IF v_old IS NOT NULL THEN
    INSERT INTO public.cache_invalidation_event (channel, tenant_id, source) VALUES (v_channel, v_old, v_source);
  END IF;
  IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN
    INSERT INTO public.cache_invalidation_event (channel, tenant_id, source) VALUES (v_channel, v_new, v_source);
  END IF;
  RETURN NULL;
END
$$;

-- D1: TRUNCATE fires no row trigger and can't name tenants, so it is refused, for every role.
CREATE FUNCTION public.refuse_cache_table_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE on % is refused: it would bypass cache invalidation capture (spec 0016 D1)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TRIGGER tenant_capture_cache_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.tenant
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:tenants:invalidate');
CREATE TRIGGER tenant_domain_capture_cache_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.tenant_domain
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:tenants:invalidate');
CREATE TRIGGER tenant_product_capture_cache_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.tenant_product
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:products:invalidate');
CREATE TRIGGER tenant_refuse_truncate BEFORE TRUNCATE ON public.tenant
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();
CREATE TRIGGER tenant_domain_refuse_truncate BEFORE TRUNCATE ON public.tenant_domain
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();
CREATE TRIGGER tenant_product_refuse_truncate BEFORE TRUNCATE ON public.tenant_product
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();

-- The event table's own guards (IO12, IO17), SECURITY INVOKER: they read only OLD and NEW.
CREATE FUNCTION public.guard_cache_invalidation_event_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a settled invalidation event can''t change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an invalidation event''s identity can''t change' USING ERRCODE = 'check_violation';
  END IF;
  -- First observation: the database's clock, at the first update (the claim's touch); never supplied, never moved.
  NEW.first_observed_at := COALESCE(OLD.first_observed_at, clock_timestamp());
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status NOT IN ('PUBLISHED', 'EXPIRED') THEN
      RAISE EXCEPTION 'an invalidation event can only move from PENDING to PUBLISHED or EXPIRED' USING ERRCODE = 'check_violation';
    END IF;
    -- D6: no expiry before first observation + the shared maximum TTL + 5 s, whoever asks.
    IF NEW.status = 'EXPIRED'
       AND clock_timestamp() < NEW.first_observed_at + public.cache_invalidation_max_ttl() + interval '5 seconds' THEN
      RAISE EXCEPTION 'too early to expire an invalidation event' USING ERRCODE = 'check_violation';
    END IF;
    NEW.settled_at := clock_timestamp();
  ELSE
    NEW.settled_at := OLD.settled_at;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.guard_cache_invalidation_event_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = 'PENDING' OR OLD.settled_at IS NULL OR OLD.settled_at >= clock_timestamp() - interval '24 hours' THEN
    RAISE EXCEPTION 'an invalidation event can be deleted only once settled for 24 hours' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER cache_invalidation_event_guard_update BEFORE UPDATE ON public.cache_invalidation_event
  FOR EACH ROW EXECUTE FUNCTION public.guard_cache_invalidation_event_update();
CREATE TRIGGER cache_invalidation_event_guard_delete BEFORE DELETE ON public.cache_invalidation_event
  FOR EACH ROW EXECUTE FUNCTION public.guard_cache_invalidation_event_delete();
CREATE TRIGGER cache_invalidation_event_refuse_truncate BEFORE TRUNCATE ON public.cache_invalidation_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();

-- Housekeeping (IO18): deletes at most `max_rows` events settled for more than 24 h. SECURITY DEFINER, so the
-- relay needs no DELETE; the delete guard enforces the same rule underneath it.
CREATE FUNCTION public.purge_settled_invalidation_events(max_rows integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF max_rows IS NULL OR max_rows < 1 OR max_rows > 10000 THEN
    RAISE EXCEPTION 'max_rows must be between 1 and 10000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.cache_invalidation_event
   WHERE id IN (SELECT e.id FROM public.cache_invalidation_event e
                 WHERE e.status <> 'PENDING' AND e.settled_at < clock_timestamp() - interval '24 hours'
                 ORDER BY e.settled_at LIMIT max_rows);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ENABLE ALWAYS (IO15): session_replication_role = replica must not skip any of the nine.
ALTER TABLE public.tenant ENABLE ALWAYS TRIGGER tenant_capture_cache_invalidation;
ALTER TABLE public.tenant_domain ENABLE ALWAYS TRIGGER tenant_domain_capture_cache_invalidation;
ALTER TABLE public.tenant_product ENABLE ALWAYS TRIGGER tenant_product_capture_cache_invalidation;
ALTER TABLE public.tenant ENABLE ALWAYS TRIGGER tenant_refuse_truncate;
ALTER TABLE public.tenant_domain ENABLE ALWAYS TRIGGER tenant_domain_refuse_truncate;
ALTER TABLE public.tenant_product ENABLE ALWAYS TRIGGER tenant_product_refuse_truncate;
ALTER TABLE public.cache_invalidation_event ENABLE ALWAYS TRIGGER cache_invalidation_event_guard_update;
ALTER TABLE public.cache_invalidation_event ENABLE ALWAYS TRIGGER cache_invalidation_event_guard_delete;
ALTER TABLE public.cache_invalidation_event ENABLE ALWAYS TRIGGER cache_invalidation_event_refuse_truncate;

-- Privileges (IO15, IO17). No function is executable by PUBLIC, now or later (triggers fire regardless:
-- EXECUTE is checked when a trigger is created, not when it fires).
ALTER DEFAULT PRIVILEGES FOR ROLE univarse_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cache_invalidation_max_ttl() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.capture_cache_invalidation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_cache_table_truncate() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_cache_invalidation_event_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_cache_invalidation_event_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_settled_invalidation_events(integer) FROM PUBLIC;
-- The API's platform role: nothing on the event table (the default privileges would give it full DML).
REVOKE ALL ON public.cache_invalidation_event FROM univarse_app_platform;
-- The relay: read, and settle; no INSERT, DELETE or TRUNCATE, nothing else (USAGE on the schema: db:setup).
GRANT SELECT, UPDATE (attempts, next_attempt_at, status, last_error) ON public.cache_invalidation_event TO univarse_relay_platform;
GRANT EXECUTE ON FUNCTION public.cache_invalidation_max_ttl() TO univarse_relay_platform;
GRANT EXECUTE ON FUNCTION public.purge_settled_invalidation_events(integer) TO univarse_relay_platform;
