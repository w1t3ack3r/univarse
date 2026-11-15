-- Spec 0038 Q7, Q8 (PR B): the institution's full export. One row per request: who asked and when, its passphrase
-- (sealed under the institution's key until the archive is sealed, then wiped), the job's lease and attempts, and
-- once built, where it is, its size, its SHA-256 and its counts. Expand only.

-- CreateEnum
CREATE TYPE "DataExportState" AS ENUM ('REQUESTED', 'BUILDING', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "data_export" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "state" "DataExportState" NOT NULL DEFAULT 'REQUESTED',
    "requested_by" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Field-encrypted (AAD names the export); NULL once the archive is sealed or the export has failed.
    "passphrase_enc" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "lease_token" UUID,
    "object_key" TEXT,
    "size_bytes" BIGINT,
    "sha256" BYTEA,
    "tables" INTEGER,
    "rows" BIGINT,
    "files" INTEGER,
    "started_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    -- Error class only, never a message (it may hold data).
    "last_error" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "data_export_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "data_export_attempts_check" CHECK ("attempts" >= 0),
    -- Waiting or being built: the passphrase is there. Anything else: it's gone.
    CONSTRAINT "data_export_passphrase_check" CHECK (("state" IN ('REQUESTED', 'BUILDING')) = ("passphrase_enc" IS NOT NULL)),
    CONSTRAINT "data_export_ready_check" CHECK (
      "state" NOT IN ('READY', 'EXPIRED') OR ("object_key" IS NOT NULL AND "size_bytes" IS NOT NULL AND "sha256" IS NOT NULL
        AND "tables" IS NOT NULL AND "rows" IS NOT NULL AND "files" IS NOT NULL AND "ready_at" IS NOT NULL AND "expires_at" IS NOT NULL)
    ),
    CONSTRAINT "data_export_failed_check" CHECK (("state" = 'FAILED') = ("failed_at" IS NOT NULL)),
    CONSTRAINT "data_export_expired_check" CHECK (("state" = 'EXPIRED') = ("expired_at" IS NOT NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "data_export_tenant_id_id_key" ON "data_export"("tenant_id", "id");
CREATE INDEX "data_export_tenant_id_requested_at_idx" ON "data_export"("tenant_id", "requested_at");
-- Q7: one at a time, whatever races the request.
CREATE UNIQUE INDEX "data_export_one_open_key" ON "data_export"("tenant_id") WHERE "state" IN ('REQUESTED', 'BUILDING');

-- Tenant isolation: forced RLS, as every tenant table (docs/07 §3).
SELECT univarse_enable_tenant_rls('data_export'::regclass);

-- Its steps only go forward: REQUESTED -> BUILDING -> READY -> EXPIRED, or to FAILED. Who asked and when never change.
-- The passphrase can be re-sealed (a key rotation) while it's needed, and is then only ever wiped (the check above).
CREATE FUNCTION public.guard_data_export_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'an export''s request can''t change (spec 0038 Q7)' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'REQUESTED' AND NEW.state IN ('BUILDING', 'FAILED'))
    OR (OLD.state = 'BUILDING' AND NEW.state IN ('READY', 'FAILED'))
    OR (OLD.state = 'READY' AND NEW.state = 'EXPIRED')
  ) OR (NEW.state = OLD.state AND OLD.state IN ('FAILED', 'EXPIRED')) THEN
    RAISE EXCEPTION 'an export''s steps only go forward (spec 0038 Q7)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state IN ('READY', 'EXPIRED') AND (NEW.object_key IS DISTINCT FROM OLD.object_key OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.ready_at IS DISTINCT FROM OLD.ready_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'a built export''s archive can''t change (spec 0038 Q8)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER data_export_guard_update BEFORE UPDATE ON public.data_export
  FOR EACH ROW EXECUTE FUNCTION public.guard_data_export_update();

-- The app asks for exports and the worker builds them; nobody deletes the record (a purge removes the institution).
REVOKE UPDATE, DELETE, TRUNCATE ON data_export FROM univarse_app;
GRANT UPDATE ("state", "passphrase_enc", "attempts", "lease_until", "lease_token", "object_key", "size_bytes", "sha256", "tables", "rows", "files",
  "started_at", "ready_at", "expires_at", "failed_at", "expired_at", "last_error", "updated_at", "version") ON data_export TO univarse_app;

-- Q-B8: the institutions that exist already get the export for their system administrators, as a new one does (the
-- seed's SYSTEM_ROLE_PERMISSIONS). FORCE RLS binds the owner too, so it's lifted for this one statement and restored in
-- the same transaction (as 20261004000000_audit_seq did).
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;
UPDATE "role" SET "permissions" = array_append("permissions", 'data.export.request'), "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'INSTITUTION_ADMIN' AND "is_system" AND NOT ('data.export.request' = ANY ("permissions"));
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
