-- Spec 0006 (envelope encryption, ADR-023): per-tenant DEKs stored only wrapped, apart from tenant data.

CREATE TYPE "DataKeyStatus" AS ENUM ('ACTIVE', 'RETIRED', 'DESTROYED');

CREATE TABLE "tenant_data_key" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DataKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "kek_id" TEXT NOT NULL,
    "wrapped_dek" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(3),
    "destroyed_at" TIMESTAMPTZ(3),
    CONSTRAINT "tenant_data_key_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_data_key_version_positive" CHECK ("version" > 0),
    -- Destroyed keys keep no key material; live keys always have it (E10).
    CONSTRAINT "tenant_data_key_destroyed_erased" CHECK (
      ("status" = 'DESTROYED' AND "wrapped_dek" IS NULL AND "destroyed_at" IS NOT NULL)
      OR ("status" <> 'DESTROYED' AND "wrapped_dek" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "tenant_data_key_tenant_id_version_key" ON "tenant_data_key"("tenant_id", "version");
-- At most one ACTIVE key per tenant: new writes always have exactly one key to use (E4).
CREATE UNIQUE INDEX "tenant_data_key_one_active" ON "tenant_data_key"("tenant_id") WHERE "status" = 'ACTIVE';

ALTER TABLE "tenant_data_key" ADD CONSTRAINT "tenant_data_key_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keys are never hard-deleted: crypto-shredding erases the wrap in place and is audited.
REVOKE DELETE, TRUNCATE ON "tenant_data_key" FROM univarse_app_platform;

-- Platform audit chain (E12): ordered by seq, append-only for the app role. The table has no rows yet
-- (nothing wrote platform audit before this release), so the NOT NULL column needs no backfill.
ALTER TABLE "platform_audit_event" ADD COLUMN "seq" BIGINT NOT NULL;
CREATE UNIQUE INDEX "platform_audit_event_seq_key" ON "platform_audit_event"("seq");
REVOKE UPDATE, DELETE, TRUNCATE ON "platform_audit_event" FROM univarse_app_platform;
