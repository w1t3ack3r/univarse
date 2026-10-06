-- Spec 0010: file lifecycle, quota reservations, scan leases. Expand-only: scan_status is kept and
-- mapped from state until a later contract release (invariant 9).

CREATE TYPE "FileState" AS ENUM (
  'PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'CLEAN', 'INFECTED', 'REJECTED', 'SCAN_FAILED', 'ABANDONED', 'DELETED'
);

ALTER TABLE "file_object"
  ADD COLUMN "state" "FileState" NOT NULL DEFAULT 'PENDING_UPLOAD',
  ADD COLUMN "detected_type" TEXT,
  ADD COLUMN "rejection_reason" TEXT,
  ADD COLUMN "scan_signature" TEXT,
  ADD COLUMN "scan_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_scan_at" TIMESTAMPTZ(3),
  ADD COLUMN "lease_until" TIMESTAMPTZ(3),
  ADD COLUMN "lease_token" UUID,
  ADD COLUMN "quarantine_key" TEXT,
  ADD COLUMN "clean_key" TEXT,
  -- FU13: bytes held against the tenant quota; zeroed exactly once on release.
  ADD COLUMN "reserved_bytes" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "upload_expires_at" TIMESTAMPTZ(3),
  ADD COLUMN "completed_at" TIMESTAMPTZ(3),
  ADD COLUMN "scanned_at" TIMESTAMPTZ(3),
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3),
  ADD COLUMN "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "file_object_reserved_nonnegative" CHECK ("reserved_bytes" >= 0),
  ADD CONSTRAINT "file_object_scan_attempts_nonnegative" CHECK ("scan_attempts" >= 0),
  -- Only a CLEAN file has a clean object and a hash; DELETED keeps neither reservation nor lease.
  ADD CONSTRAINT "file_object_clean_has_hash" CHECK ("state" <> 'CLEAN' OR ("clean_key" IS NOT NULL AND "sha256" IS NOT NULL)),
  ADD CONSTRAINT "file_object_deleted_released" CHECK ("state" <> 'DELETED' OR ("reserved_bytes" = 0 AND "deleted_at" IS NOT NULL));

-- Worker claims and quota sums stay index-backed.
CREATE INDEX "file_object_tenant_state_next" ON "file_object" ("tenant_id", "state", "next_scan_at");
CREATE INDEX "file_object_tenant_uploader" ON "file_object" ("tenant_id", "uploaded_by_id");
