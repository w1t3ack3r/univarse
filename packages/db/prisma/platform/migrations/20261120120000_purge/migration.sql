-- Spec 0038 Q9–Q13 (PR C): an archived institution's purge. The console asks for it and a second member approves it
-- (a `tenant.purge` approval, whose execution is the authorisation, Q-C1); the host's `pnpm stack:purge` runs the steps
-- as the migrator, each recorded here once and in order, so a stopped purge resumes where it stopped. What stays of the
-- institution is its tenant row as a tombstone, with the certificate's hash. Expand only.

-- The approval engine's new kind (Q9) and its failure when the institution is no longer archived.
ALTER TABLE "platform_approval" DROP CONSTRAINT "platform_approval_kind_check";
ALTER TABLE "platform_approval" ADD CONSTRAINT "platform_approval_kind_check" CHECK ("kind" IN ('staff.make_owner', 'tenant.purge'));
ALTER TABLE "platform_approval" DROP CONSTRAINT "platform_approval_failure_check";
ALTER TABLE "platform_approval" ADD CONSTRAINT "platform_approval_failure_check" CHECK (
  ("status" = 'FAILED') = ("failure_code" IS NOT NULL)
  AND ("failure_code" IS NULL OR "failure_code" IN ('subject_gone', 'subject_inactive', 'already_done', 'state_conflict', 'not_archived'))
);

-- Q12, Q13: the tombstone's own facts.
ALTER TABLE "tenant" ADD COLUMN "purged_at" TIMESTAMPTZ(3);
ALTER TABLE "tenant" ADD COLUMN "purge_certificate_sha256" TEXT;
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_purge_certificate_check" CHECK ("purge_certificate_sha256" IS NULL OR "purge_certificate_sha256" ~ '^[0-9a-f]{64}$');

-- CreateTable
CREATE TABLE "platform_tenant_purge" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    -- The executed `tenant.purge` approval it used (Q-C1), or null for a solo purge (Q11).
    "approval_id" UUID,
    "solo" BOOLEAN NOT NULL,
    -- A solo purge's reason (the owner's own words): on this row and the certificate, never the audit chain.
    "reason" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Step 1: the key-destruction protocol's op, as the ledger records it.
    "keys_op" UUID,
    "keys_destroyed_at" TIMESTAMPTZ(3),
    -- Step 2: rows deleted, per tenant table.
    "rows" JSONB,
    "rows_deleted_at" TIMESTAMPTZ(3),
    -- Step 3: storage objects deleted under tenants/{id}/, per bucket.
    "objects" JSONB,
    "objects_deleted_at" TIMESTAMPTZ(3),
    -- Step 4: platform rows deleted, per table.
    "platform_rows" JSONB,
    "platform_deleted_at" TIMESTAMPTZ(3),
    -- Step 5: the certificate as written on the host, and its SHA-256 (also on the tenant).
    "certificate" JSONB,
    "certificate_sha256" TEXT,
    "certificate_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_tenant_purge_pkey" PRIMARY KEY ("id"),
    -- Two people (an approval) or one, solo, with a reason: never both, never neither.
    CONSTRAINT "platform_tenant_purge_who_check" CHECK (
      ("solo" AND "approval_id" IS NULL AND "reason" IS NOT NULL AND char_length("reason") BETWEEN 10 AND 500)
      OR (NOT "solo" AND "approval_id" IS NOT NULL AND "reason" IS NULL)
    ),
    -- Q10, A12: each step only after the one before it; each step's facts with its time.
    CONSTRAINT "platform_tenant_purge_order_check" CHECK (
      ("rows_deleted_at" IS NULL OR "keys_destroyed_at" IS NOT NULL)
      AND ("objects_deleted_at" IS NULL OR "rows_deleted_at" IS NOT NULL)
      AND ("platform_deleted_at" IS NULL OR "objects_deleted_at" IS NOT NULL)
      AND ("certificate_at" IS NULL OR "platform_deleted_at" IS NOT NULL)
    ),
    CONSTRAINT "platform_tenant_purge_facts_check" CHECK (
      ("keys_destroyed_at" IS NULL) = ("keys_op" IS NULL)
      AND ("rows_deleted_at" IS NULL) = ("rows" IS NULL)
      AND ("objects_deleted_at" IS NULL) = ("objects" IS NULL)
      AND ("platform_deleted_at" IS NULL) = ("platform_rows" IS NULL)
      AND ("certificate_at" IS NULL) = ("certificate" IS NULL)
      AND ("certificate_at" IS NULL) = ("certificate_sha256" IS NULL)
      AND ("certificate_sha256" IS NULL OR "certificate_sha256" ~ '^[0-9a-f]{64}$')
    )
);

-- CreateIndex: one purge per institution; an authorisation used once.
CREATE UNIQUE INDEX "platform_tenant_purge_tenant_id_key" ON "platform_tenant_purge"("tenant_id");
CREATE UNIQUE INDEX "platform_tenant_purge_approval_id_key" ON "platform_tenant_purge"("approval_id");

-- AddForeignKey
ALTER TABLE "platform_tenant_purge" ADD CONSTRAINT "platform_tenant_purge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_tenant_purge" ADD CONSTRAINT "platform_tenant_purge_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "platform_approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who and why never change; a step, once recorded, is never changed or undone (for every role, the migrator included).
CREATE FUNCTION public.guard_platform_tenant_purge_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.solo IS DISTINCT FROM OLD.solo OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'a purge''s authority can''t change (spec 0038 Q9)' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.keys_destroyed_at IS NOT NULL AND (NEW.keys_destroyed_at IS DISTINCT FROM OLD.keys_destroyed_at OR NEW.keys_op IS DISTINCT FROM OLD.keys_op))
     OR (OLD.rows_deleted_at IS NOT NULL AND (NEW.rows_deleted_at IS DISTINCT FROM OLD.rows_deleted_at OR NEW.rows IS DISTINCT FROM OLD.rows))
     OR (OLD.objects_deleted_at IS NOT NULL AND (NEW.objects_deleted_at IS DISTINCT FROM OLD.objects_deleted_at OR NEW.objects IS DISTINCT FROM OLD.objects))
     OR (OLD.platform_deleted_at IS NOT NULL AND (NEW.platform_deleted_at IS DISTINCT FROM OLD.platform_deleted_at OR NEW.platform_rows IS DISTINCT FROM OLD.platform_rows))
     OR (OLD.certificate_at IS NOT NULL AND (NEW.certificate_at IS DISTINCT FROM OLD.certificate_at OR NEW.certificate IS DISTINCT FROM OLD.certificate OR NEW.certificate_sha256 IS DISTINCT FROM OLD.certificate_sha256)) THEN
    RAISE EXCEPTION 'a purge''s step is recorded once (spec 0038 Q10)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_tenant_purge_guard_update BEFORE UPDATE ON public.platform_tenant_purge
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_tenant_purge_update();

-- Privileges. The purge job writes as the migrator (the table's owner). The console reads it, and the tombstone's facts;
-- the tenant API's role has nothing to do with it.
REVOKE ALL ON public.platform_tenant_purge FROM univarse_app_platform;
GRANT SELECT ON public.platform_tenant_purge TO univarse_console;
GRANT SELECT (purged_at, purge_certificate_sha256) ON public.tenant TO univarse_console;
