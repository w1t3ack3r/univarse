-- Spec 0041 Q6 (P2-S0): which institution-type profile each institution was given, exactly: the template and version,
-- the content hash, where it came from, its status and when. One row per institution and version. Expand only.
-- Wrapped in one transaction (spec 0039 Q-A3): Prisma doesn't roll a failed PostgreSQL migration back by itself.
BEGIN;

-- CreateEnum
CREATE TYPE "ProfileAssignmentSource" AS ENUM ('PROVISIONING', 'SEED', 'BACKFILL');

-- CreateEnum
CREATE TYPE "ProfileAssignmentStatus" AS ENUM ('PENDING', 'ASSIGNED', 'FAILED');

-- CreateTable
CREATE TABLE "tenant_profile_assignment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "source" "ProfileAssignmentSource" NOT NULL,
    "status" "ProfileAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "error_code" TEXT,
    "assigned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_profile_assignment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_profile_assignment_template_check" CHECK ("template" ~ '^[a-z][a-z-]*[a-z]$'),
    CONSTRAINT "tenant_profile_assignment_version_check" CHECK ("template_version" >= 1),
    CONSTRAINT "tenant_profile_assignment_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    -- ASSIGNED has its time and no error; FAILED has a fixed code (never a message: it could carry a host); PENDING neither.
    CONSTRAINT "tenant_profile_assignment_status_check" CHECK (
      ("status" = 'ASSIGNED' AND "assigned_at" IS NOT NULL AND "error_code" IS NULL)
      OR ("status" = 'FAILED' AND "assigned_at" IS NULL AND "error_code" IN ('shard_unavailable', 'hash_mismatch', 'database', 'unexpected'))
      OR ("status" = 'PENDING' AND "assigned_at" IS NULL AND "error_code" IS NULL)
    )
);

-- CreateIndex
CREATE INDEX "tenant_profile_assignment_status_idx" ON "tenant_profile_assignment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_profile_assignment_tenant_id_template_template_versi_key" ON "tenant_profile_assignment"("tenant_id", "template", "template_version");

-- AddForeignKey
ALTER TABLE "tenant_profile_assignment" ADD CONSTRAINT "tenant_profile_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An assignment only goes forward: PENDING -> ASSIGNED, or PENDING -> FAILED -> PENDING (a retry) -> ASSIGNED. What
-- was assigned (the template, its version, its hash, the institution) never changes; an ASSIGNED row never changes.
CREATE FUNCTION public.guard_tenant_profile_assignment_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.template IS DISTINCT FROM OLD.template
     OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a profile assignment''s profile can''t change (spec 0041 Q6)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'ASSIGNED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'an assigned profile can''t change (spec 0041 Q7)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenant_profile_assignment_guard_update BEFORE UPDATE ON public.tenant_profile_assignment
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_profile_assignment_update();

-- The worker and the seed (the app's role) write assignments; nobody deletes one but the purge (the migrator). The
-- console reads them for the institution's page (Q8).
REVOKE ALL ON public.tenant_profile_assignment FROM univarse_app_platform;
GRANT SELECT, INSERT, UPDATE (status, error_code, assigned_at, updated_at) ON public.tenant_profile_assignment TO univarse_app_platform;
GRANT SELECT ON public.tenant_profile_assignment TO univarse_console;

COMMIT;
