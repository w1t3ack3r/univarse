-- Spec 0037 Q6, Q7: suspending an institution and resuming it. One row per suspension: who, when, why and the status
-- it had, then who resumed it, and when the worker ended its sessions. The record of a suspension never changes once
-- written (a trigger, for every role); a resume and the session ending are each recorded once. Expand only.

-- CreateTable
CREATE TABLE "platform_tenant_suspension" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "previous_status" "TenantStatus" NOT NULL,
    "suspended_by" UUID NOT NULL,
    "suspended_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumed_by" UUID,
    "resumed_at" TIMESTAMPTZ(3),
    "sessions_ended_at" TIMESTAMPTZ(3),
    "sessions_ended" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_tenant_suspension_pkey" PRIMARY KEY ("id"),
    -- Q6's fixed list. Non-payment isn't on it (spec 0030).
    CONSTRAINT "platform_tenant_suspension_reason_check" CHECK ("reason" IN ('SECURITY_INCIDENT', 'REGULATOR_ORDER', 'CONTRACT_ENDED', 'INSTITUTION_ASKED', 'OTHER')),
    CONSTRAINT "platform_tenant_suspension_note_check" CHECK (
      ("note" IS NULL OR char_length("note") BETWEEN 3 AND 200) AND ("reason" <> 'OTHER' OR "note" IS NOT NULL)
    ),
    CONSTRAINT "platform_tenant_suspension_previous_check" CHECK ("previous_status" IN ('ACTIVE', 'ONBOARDING')),
    CONSTRAINT "platform_tenant_suspension_resumed_check" CHECK (("resumed_by" IS NULL) = ("resumed_at" IS NULL)),
    CONSTRAINT "platform_tenant_suspension_sessions_check" CHECK (("sessions_ended_at" IS NULL) = ("sessions_ended" IS NULL) AND ("sessions_ended" IS NULL OR "sessions_ended" >= 0)),
    -- Q7: an institution comes back only after its sessions are gone.
    CONSTRAINT "platform_tenant_suspension_resume_after_sessions_check" CHECK ("resumed_at" IS NULL OR "sessions_ended_at" IS NOT NULL)
);

-- CreateIndex: at most one open suspension per institution.
CREATE UNIQUE INDEX "platform_tenant_suspension_open_key" ON "platform_tenant_suspension"("tenant_id") WHERE "resumed_at" IS NULL;
CREATE INDEX "platform_tenant_suspension_tenant_id_suspended_at_idx" ON "platform_tenant_suspension"("tenant_id", "suspended_at");
-- The worker's pass: suspensions whose sessions aren't ended yet.
CREATE INDEX "platform_tenant_suspension_sessions_pending_idx" ON "platform_tenant_suspension"("suspended_at") WHERE "sessions_ended_at" IS NULL;

-- AddForeignKey
ALTER TABLE "platform_tenant_suspension" ADD CONSTRAINT "platform_tenant_suspension_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_tenant_suspension" ADD CONSTRAINT "platform_tenant_suspension_suspended_by_fkey" FOREIGN KEY ("suspended_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_tenant_suspension" ADD CONSTRAINT "platform_tenant_suspension_resumed_by_fkey" FOREIGN KEY ("resumed_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What was decided never changes; a resume and the session ending are each written once.
CREATE FUNCTION public.guard_platform_tenant_suspension_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.previous_status IS DISTINCT FROM OLD.previous_status OR NEW.suspended_by IS DISTINCT FROM OLD.suspended_by
     OR NEW.suspended_at IS DISTINCT FROM OLD.suspended_at THEN
    RAISE EXCEPTION 'a suspension''s record can''t change (spec 0037 Q6)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.resumed_at IS NOT NULL AND (NEW.resumed_at IS DISTINCT FROM OLD.resumed_at OR NEW.resumed_by IS DISTINCT FROM OLD.resumed_by) THEN
    RAISE EXCEPTION 'a suspension is resumed once (spec 0037 Q6)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sessions_ended_at IS NOT NULL AND (NEW.sessions_ended_at IS DISTINCT FROM OLD.sessions_ended_at OR NEW.sessions_ended IS DISTINCT FROM OLD.sessions_ended) THEN
    RAISE EXCEPTION 'a suspension''s sessions are ended once (spec 0037 Q7)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER platform_tenant_suspension_guard_update BEFORE UPDATE ON public.platform_tenant_suspension
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_tenant_suspension_update();

-- Privileges. Nobody deletes a suspension.
REVOKE ALL ON public.platform_tenant_suspension FROM univarse_app_platform;

-- The console role suspends and resumes. It can't write the session ending: that's the worker's (A2, it holds the
-- tenant credential).
GRANT SELECT ON public.platform_tenant_suspension TO univarse_console;
GRANT INSERT (tenant_id, reason, note, previous_status, suspended_by, updated_at) ON public.platform_tenant_suspension TO univarse_console;
GRANT UPDATE (resumed_by, resumed_at, updated_at, version) ON public.platform_tenant_suspension TO univarse_console;

-- The worker (univarse_app_platform) finds the suspensions whose sessions are still to end, and records that it did.
GRANT SELECT (id, tenant_id, suspended_at, sessions_ended_at) ON public.platform_tenant_suspension TO univarse_app_platform;
GRANT UPDATE (sessions_ended_at, sessions_ended, updated_at) ON public.platform_tenant_suspension TO univarse_app_platform;
