-- Spec 0037 Q13, Q14 (E19): incidents. An incident's current state is on its row; its timeline is the record, one row
-- per update, append-only for every role (a trigger). Each update has public text (shown at the affected institutions)
-- and may have an internal note (staff only: no role outside the console can read it). The affected institutions are
-- decided when it's opened, a row each; each row's change reaches that institution's cache (spec 0016's capture), so an
-- incident's banner shows and changes at once. Expand only.

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');
CREATE TYPE "IncidentStatus" AS ENUM ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED');
CREATE TYPE "PersonalDataInvolved" AS ENUM ('YES', 'NO', 'UNKNOWN');
CREATE TYPE "IncidentScope" AS ENUM ('ALL', 'TENANTS');

-- CreateTable
CREATE TABLE "platform_incident" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "title" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "scope" "IncidentScope" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
    "personal_data" "PersonalDataInvolved" NOT NULL DEFAULT 'UNKNOWN',
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "aware_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "followup_what" TEXT,
    "followup_actions" TEXT,
    "opened_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_incident_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_incident_title_check" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "platform_incident_aware_check" CHECK ("aware_at" >= "started_at"),
    CONSTRAINT "platform_incident_resolved_check" CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL)),
    -- The follow-up is written after resolving (Q13), staff only.
    CONSTRAINT "platform_incident_followup_check" CHECK (
      ("followup_what" IS NULL AND "followup_actions" IS NULL) OR "status" = 'RESOLVED'
    ),
    CONSTRAINT "platform_incident_followup_length_check" CHECK (
      char_length(COALESCE("followup_what", '')) <= 4000 AND char_length(COALESCE("followup_actions", '')) <= 4000
    )
);

CREATE TABLE "platform_incident_update" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "incident_id" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "personal_data" "PersonalDataInvolved" NOT NULL,
    "public_text" TEXT NOT NULL,
    "internal_note" TEXT,
    "posted_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_incident_update_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_incident_update_public_check" CHECK (char_length("public_text") BETWEEN 1 AND 1000),
    CONSTRAINT "platform_incident_update_note_check" CHECK ("internal_note" IS NULL OR char_length("internal_note") BETWEEN 1 AND 2000)
);

CREATE TABLE "platform_incident_tenant" (
    "incident_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Moved forward by every update, so the institution's cache hears of it (the capture fires on this column).
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_incident_tenant_pkey" PRIMARY KEY ("incident_id", "tenant_id")
);

-- CreateIndex
CREATE INDEX "platform_incident_status_idx" ON "platform_incident"("status", "resolved_at");
CREATE INDEX "platform_incident_update_incident_id_created_at_idx" ON "platform_incident_update"("incident_id", "created_at");
CREATE INDEX "platform_incident_tenant_tenant_id_idx" ON "platform_incident_tenant"("tenant_id");

-- AddForeignKey
ALTER TABLE "platform_incident" ADD CONSTRAINT "platform_incident_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_incident_update" ADD CONSTRAINT "platform_incident_update_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "platform_incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_incident_update" ADD CONSTRAINT "platform_incident_update_posted_by_fkey" FOREIGN KEY ("posted_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_incident_tenant" ADD CONSTRAINT "platform_incident_tenant_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "platform_incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_incident_tenant" ADD CONSTRAINT "platform_incident_tenant_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Q13: the timeline is append-only, for every role.
CREATE FUNCTION public.refuse_platform_incident_update_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'an incident''s timeline is append-only (spec 0037 Q13)' USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER platform_incident_update_append_only BEFORE UPDATE OR DELETE ON public.platform_incident_update
  FOR EACH ROW EXECUTE FUNCTION public.refuse_platform_incident_update_change();

-- What was opened stays as opened; a resolved incident is final (a recurrence is a new one), but for its follow-up.
CREATE FUNCTION public.guard_platform_incident_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.aware_at IS DISTINCT FROM OLD.aware_at OR NEW.opened_by IS DISTINCT FROM OLD.opened_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an incident''s opening can''t change (spec 0037 Q13)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'RESOLVED' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
     OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.personal_data IS DISTINCT FROM OLD.personal_data) THEN
    RAISE EXCEPTION 'a resolved incident is final (spec 0037 Q13)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_incident_guard_update BEFORE UPDATE ON public.platform_incident
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_incident_update();

-- The affected institutions never move.
CREATE FUNCTION public.guard_platform_incident_tenant_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.incident_id IS DISTINCT FROM OLD.incident_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an incident''s institutions can''t change (spec 0037 Q13)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_incident_tenant_guard_update BEFORE UPDATE ON public.platform_incident_tenant
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_incident_tenant_update();

-- Spec 0016: an affected institution's arrival, or an update's touch, reaches every API instance's tenant cache.
CREATE TRIGGER platform_incident_tenant_capture_cache_invalidation AFTER INSERT OR DELETE OR UPDATE OF changed_at ON public.platform_incident_tenant
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:tenants:invalidate');
CREATE TRIGGER platform_incident_tenant_refuse_truncate BEFORE TRUNCATE ON public.platform_incident_tenant
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();
-- IO15: session_replication_role = replica must not skip them (the capture gate checks).
ALTER TABLE public.platform_incident_tenant ENABLE ALWAYS TRIGGER platform_incident_tenant_capture_cache_invalidation;
ALTER TABLE public.platform_incident_tenant ENABLE ALWAYS TRIGGER platform_incident_tenant_refuse_truncate;

-- Privileges. Start the tenant API's platform role from none.
REVOKE ALL ON public.platform_incident, public.platform_incident_update, public.platform_incident_tenant FROM univarse_app_platform;

-- The console role opens, updates and resolves; it never deletes, and never changes an update.
GRANT SELECT ON public.platform_incident, public.platform_incident_update, public.platform_incident_tenant TO univarse_console;
GRANT INSERT (title, severity, scope, personal_data, started_at, aware_at, opened_by, updated_at) ON public.platform_incident TO univarse_console;
GRANT UPDATE (status, severity, personal_data, resolved_at, followup_what, followup_actions, updated_at, version) ON public.platform_incident TO univarse_console;
GRANT INSERT (incident_id, status, severity, personal_data, public_text, internal_note, posted_by) ON public.platform_incident_update TO univarse_console;
GRANT INSERT (incident_id, tenant_id) ON public.platform_incident_tenant TO univarse_console;
GRANT UPDATE (changed_at) ON public.platform_incident_tenant TO univarse_console;

-- The tenant API reads what an institution's banner needs, by column: never an internal note, the follow-up, the
-- personal-data flag or who did anything.
GRANT SELECT (id, title, status, started_at, resolved_at) ON public.platform_incident TO univarse_app_platform;
GRANT SELECT (id, incident_id, status, public_text, created_at) ON public.platform_incident_update TO univarse_app_platform;
GRANT SELECT (incident_id, tenant_id) ON public.platform_incident_tenant TO univarse_app_platform;
