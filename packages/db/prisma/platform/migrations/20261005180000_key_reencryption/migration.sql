-- Spec 0006 PR B (E7, E9): one pending re-encryption sweep per tenant, claimed by the worker under a lease.

CREATE TYPE "ReencryptionReason" AS ENUM ('ROTATION', 'LEGACY_V1');

CREATE TABLE "key_reencryption" (
    "tenant_id" UUID NOT NULL,
    "reason" "ReencryptionReason" NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "rows_reencrypted" BIGINT NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    CONSTRAINT "key_reencryption_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "key_reencryption_rows_nonnegative" CHECK ("rows_reencrypted" >= 0)
);

-- Pending = never completed, or re-requested after the last completion.
CREATE INDEX "key_reencryption_pending" ON "key_reencryption"("requested_at") WHERE "completed_at" IS NULL;

ALTER TABLE "key_reencryption" ADD CONSTRAINT "key_reencryption_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

REVOKE DELETE, TRUNCATE ON "key_reencryption" FROM univarse_app_platform;
