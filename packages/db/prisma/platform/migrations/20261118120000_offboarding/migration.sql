-- Spec 0038 Q2–Q6: an institution's departure, before the purge. One row per offboarding: why, from what, by whom and
-- when, when its window ends, then a cancellation, the archive, the session ending and one extension. Each warning
-- sent is a row, once per (round, days left). What was decided never changes (a trigger, for every role). Expand only.

-- A suspension during the window returns to it (Q3).
ALTER TABLE "platform_tenant_suspension" DROP CONSTRAINT "platform_tenant_suspension_previous_check";
ALTER TABLE "platform_tenant_suspension" ADD CONSTRAINT "platform_tenant_suspension_previous_check" CHECK ("previous_status" IN ('ACTIVE', 'ONBOARDING', 'OFFBOARDING'));

-- CreateTable
CREATE TABLE "platform_tenant_offboarding" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "previous_status" "TenantStatus" NOT NULL,
    "started_by" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The window's end as first set (60 days) and as it stands now (an extension moves it).
    "first_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "sessions_ended_at" TIMESTAMPTZ(3),
    "extended_by" UUID,
    "extended_at" TIMESTAMPTZ(3),
    "extension_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_tenant_offboarding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_tenant_offboarding_reason_check" CHECK ("reason" IN ('CONTRACT_ENDED', 'INSTITUTION_ASKED', 'REGULATOR_ORDER', 'OTHER')),
    CONSTRAINT "platform_tenant_offboarding_note_check" CHECK (
      ("note" IS NULL OR char_length("note") BETWEEN 3 AND 200) AND ("reason" <> 'OTHER' OR "note" IS NOT NULL)
    ),
    CONSTRAINT "platform_tenant_offboarding_previous_check" CHECK ("previous_status" IN ('ACTIVE', 'ONBOARDING')),
    CONSTRAINT "platform_tenant_offboarding_window_check" CHECK ("first_ends_at" > "started_at" AND "ends_at" > "started_at"),
    CONSTRAINT "platform_tenant_offboarding_cancelled_check" CHECK (("cancelled_by" IS NULL) = ("cancelled_at" IS NULL)),
    -- A cancelled window was never archived, and an archived one can't be cancelled.
    CONSTRAINT "platform_tenant_offboarding_cancel_or_archive_check" CHECK ("cancelled_at" IS NULL OR "archived_at" IS NULL),
    CONSTRAINT "platform_tenant_offboarding_extended_check" CHECK (
      ("extended_at" IS NULL) = ("extended_by" IS NULL) AND ("extended_at" IS NULL) = ("extension_reason" IS NULL)
      AND ("extension_reason" IS NULL OR char_length("extension_reason") BETWEEN 3 AND 200)
      AND (("extended_at" IS NULL) = ("ends_at" = "first_ends_at"))
    )
);

CREATE TABLE "platform_offboarding_warning" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "offboarding_id" UUID NOT NULL,
    -- 0: the first window; 1: the extension.
    "round" SMALLINT NOT NULL,
    "days_left" SMALLINT NOT NULL,
    "it_admins" INTEGER,
    "emails_queued" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queued_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_offboarding_warning_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_offboarding_warning_days_check" CHECK (
      ("round" = 0 AND "days_left" IN (60, 45, 30, 14, 7, 1)) OR ("round" = 1 AND "days_left" IN (14, 7, 1))
    ),
    CONSTRAINT "platform_offboarding_warning_counts_check" CHECK (
      ("queued_at" IS NULL) = ("emails_queued" IS NULL) AND ("queued_at" IS NULL) = ("it_admins" IS NULL)
      AND COALESCE("emails_queued", 0) BETWEEN 0 AND COALESCE("it_admins", 0)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_tenant_offboarding_open_key" ON "platform_tenant_offboarding"("tenant_id") WHERE "cancelled_at" IS NULL;
CREATE INDEX "platform_tenant_offboarding_tenant_id_started_at_idx" ON "platform_tenant_offboarding"("tenant_id", "started_at");
CREATE UNIQUE INDEX "platform_offboarding_warning_once_key" ON "platform_offboarding_warning"("offboarding_id", "round", "days_left");

-- AddForeignKey
ALTER TABLE "platform_tenant_offboarding" ADD CONSTRAINT "platform_tenant_offboarding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_tenant_offboarding" ADD CONSTRAINT "platform_tenant_offboarding_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_tenant_offboarding" ADD CONSTRAINT "platform_tenant_offboarding_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_tenant_offboarding" ADD CONSTRAINT "platform_tenant_offboarding_extended_by_fkey" FOREIGN KEY ("extended_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_offboarding_warning" ADD CONSTRAINT "platform_offboarding_warning_offboarding_id_fkey" FOREIGN KEY ("offboarding_id") REFERENCES "platform_tenant_offboarding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What was decided never changes; a cancellation, an extension and the first session ending are each written once.
CREATE FUNCTION public.guard_platform_tenant_offboarding_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.previous_status IS DISTINCT FROM OLD.previous_status OR NEW.started_by IS DISTINCT FROM OLD.started_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.first_ends_at IS DISTINCT FROM OLD.first_ends_at THEN
    RAISE EXCEPTION 'an offboarding''s record can''t change (spec 0038 Q2)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by) THEN
    RAISE EXCEPTION 'an offboarding is cancelled once (spec 0038 Q2)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.extended_at IS NOT NULL AND (NEW.extended_at IS DISTINCT FROM OLD.extended_at OR NEW.extended_by IS DISTINCT FROM OLD.extended_by
     OR NEW.extension_reason IS DISTINCT FROM OLD.extension_reason OR NEW.ends_at IS DISTINCT FROM OLD.ends_at) THEN
    RAISE EXCEPTION 'an offboarding is extended once (spec 0038 Q6)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_tenant_offboarding_guard_update BEFORE UPDATE ON public.platform_tenant_offboarding
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_tenant_offboarding_update();

-- A warning names its offboarding, round and day for good; its counts are written once.
CREATE FUNCTION public.guard_platform_offboarding_warning_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.offboarding_id IS DISTINCT FROM OLD.offboarding_id OR NEW.round IS DISTINCT FROM OLD.round OR NEW.days_left IS DISTINCT FROM OLD.days_left
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a warning''s identity can''t change (spec 0038 Q4)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.queued_at IS NOT NULL AND (NEW.queued_at IS DISTINCT FROM OLD.queued_at OR NEW.it_admins IS DISTINCT FROM OLD.it_admins OR NEW.emails_queued IS DISTINCT FROM OLD.emails_queued) THEN
    RAISE EXCEPTION 'a warning is queued once (spec 0038 Q4)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_offboarding_warning_guard_update BEFORE UPDATE ON public.platform_offboarding_warning
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_offboarding_warning_update();

-- Privileges. Start the tenant API's (and worker's) platform role from none on the new tables.
REVOKE ALL ON public.platform_tenant_offboarding, public.platform_offboarding_warning FROM univarse_app_platform;

-- The console starts, cancels and extends; it never archives, ends sessions or writes a warning (the worker does).
GRANT SELECT ON public.platform_tenant_offboarding, public.platform_offboarding_warning TO univarse_console;
GRANT INSERT (tenant_id, reason, note, previous_status, started_by, first_ends_at, ends_at, updated_at) ON public.platform_tenant_offboarding TO univarse_console;
GRANT UPDATE (cancelled_by, cancelled_at, extended_by, extended_at, extension_reason, ends_at, updated_at, version) ON public.platform_tenant_offboarding TO univarse_console;
GRANT UPDATE (offboarding_started_at, purge_after) ON public.tenant TO univarse_console;

-- The worker (univarse_app_platform) archives, ends the sessions and sends the warnings, by column.
GRANT SELECT (id, tenant_id, started_at, ends_at, cancelled_at, archived_at, sessions_ended_at, extended_at) ON public.platform_tenant_offboarding TO univarse_app_platform;
GRANT UPDATE (archived_at, sessions_ended_at, updated_at) ON public.platform_tenant_offboarding TO univarse_app_platform;
GRANT SELECT ON public.platform_offboarding_warning TO univarse_app_platform;
GRANT INSERT (offboarding_id, round, days_left) ON public.platform_offboarding_warning TO univarse_app_platform;
GRANT UPDATE (it_admins, emails_queued, queued_at) ON public.platform_offboarding_warning TO univarse_app_platform;
