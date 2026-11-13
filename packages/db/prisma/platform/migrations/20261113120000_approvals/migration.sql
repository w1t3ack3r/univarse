-- Spec 0037 Q2, Q3 (E4, T24): the two-person approval engine. One row per request; its payload and hash are written
-- once and never change, and its status moves only forward, once (a trigger, for every role). Expand only.

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'EXECUTED', 'FAILED');

-- CreateTable
CREATE TABLE "platform_approval" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "subject_id" UUID,
    "reason" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "executed_at" TIMESTAMPTZ(3),
    "failure_code" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_approval_pkey" PRIMARY KEY ("id"),
    -- The kinds packages/domain declares (Q2), and nothing else.
    CONSTRAINT "platform_approval_kind_check" CHECK ("kind" IN ('staff.make_owner')),
    CONSTRAINT "platform_approval_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "platform_approval_reason_check" CHECK (char_length("reason") BETWEEN 3 AND 500),
    CONSTRAINT "platform_approval_expiry_check" CHECK ("expires_at" > "created_at"),
    -- Q3, held by the database too: nobody decides their own request, or one that names them.
    CONSTRAINT "platform_approval_not_own_check" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
    CONSTRAINT "platform_approval_not_subject_check" CHECK ("decided_by" IS NULL OR "subject_id" IS NULL OR "decided_by" <> "subject_id"),
    -- A decision names who made it and when; a cancellation is the requester's, and an expiry nobody's.
    CONSTRAINT "platform_approval_decided_check" CHECK (
      ("status" IN ('APPROVED', 'REJECTED', 'EXECUTED', 'FAILED')) = ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
    ),
    CONSTRAINT "platform_approval_executed_check" CHECK (("status" IN ('EXECUTED', 'FAILED')) = ("executed_at" IS NOT NULL)),
    -- Fixed codes only (as spec 0034 Q4): no driver message can be stored.
    CONSTRAINT "platform_approval_failure_check" CHECK (
      ("status" = 'FAILED') = ("failure_code" IS NOT NULL)
      AND ("failure_code" IS NULL OR "failure_code" IN ('subject_gone', 'subject_inactive', 'already_done', 'state_conflict'))
    )
);

-- CreateIndex
CREATE INDEX "platform_approval_status_expires_at_idx" ON "platform_approval"("status", "expires_at");
CREATE INDEX "platform_approval_requested_by_idx" ON "platform_approval"("requested_by");

-- AddForeignKey
ALTER TABLE "platform_approval" ADD CONSTRAINT "platform_approval_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_approval" ADD CONSTRAINT "platform_approval_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Q3: single use, for every role. What was asked never changes, a request moves forward only, and a finished one is
-- final: PENDING to APPROVED, REJECTED, CANCELLED, EXPIRED, EXECUTED or FAILED; APPROVED to EXECUTED or FAILED (a long
-- job, queued from the approval's transaction, S7).
CREATE FUNCTION public.guard_platform_approval_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an approval request can''t change once made (spec 0037 Q3)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'EXECUTED', 'FAILED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('EXECUTED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'an approval moves forward once (spec 0037 Q3): % to % is refused', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.decided_by IS NOT NULL AND NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
    RAISE EXCEPTION 'an approval''s decider can''t change (spec 0037 Q3)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER platform_approval_guard_update BEFORE UPDATE ON public.platform_approval
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_approval_update();

-- Privileges. The migrator's default privileges would give the tenant API's platform role full DML: it gets nothing.
REVOKE ALL ON public.platform_approval FROM univarse_app_platform;

-- The console role makes, reads and decides requests. It can't set the status, decider or version on insert (the
-- defaults hold), never updates the request itself (the trigger, too), and never deletes.
GRANT SELECT ON public.platform_approval TO univarse_console;
GRANT INSERT (kind, payload, payload_hash, subject_id, reason, requested_by, expires_at, updated_at) ON public.platform_approval TO univarse_console;
GRANT UPDATE (status, decided_by, decided_at, executed_at, failure_code, updated_at, version) ON public.platform_approval TO univarse_console;
