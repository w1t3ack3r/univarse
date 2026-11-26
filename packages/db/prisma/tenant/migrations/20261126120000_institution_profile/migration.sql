-- Spec 0041 Q4 (P2-S0): the institution-type profile each institution was assigned, as it was. One row per template
-- version; append-only for the app (a later version is a new row, never an edit). Later slices project their part
-- into their own editable tables from here, in SQL for institutions already live. Expand only.
-- Wrapped in one transaction (spec 0039 Q-A3): Prisma doesn't roll a failed PostgreSQL migration back by itself.
BEGIN;

-- CreateEnum
CREATE TYPE "ProfileSource" AS ENUM ('PROVISIONING', 'SEED', 'BACKFILL');

-- CreateTable
CREATE TABLE "institution_profile" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "content_hash" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "source" "ProfileSource" NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "institution_profile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "institution_profile_template_check" CHECK ("template" ~ '^[a-z][a-z-]*[a-z]$'),
    CONSTRAINT "institution_profile_version_check" CHECK ("template_version" >= 1),
    -- SHA-256, lower-case hex.
    CONSTRAINT "institution_profile_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "institution_profile_profile_check" CHECK (jsonb_typeof("profile") = 'object')
);

-- CreateIndex
CREATE UNIQUE INDEX "institution_profile_tenant_id_id_key" ON "institution_profile"("tenant_id", "id");
-- Q5: assigning again never makes a second row.
CREATE UNIQUE INDEX "institution_profile_tenant_id_template_template_version_key" ON "institution_profile"("tenant_id", "template", "template_version");

-- Tenant isolation: forced RLS, as every tenant table (docs/07 §3).
SELECT univarse_enable_tenant_rls('institution_profile'::regclass);

-- Append-only: the app inserts and reads; only the purge (the migrator) deletes an institution's rows.
REVOKE UPDATE, DELETE, TRUNCATE ON institution_profile FROM univarse_app;

COMMIT;
