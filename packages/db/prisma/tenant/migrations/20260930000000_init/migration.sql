-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrgUnitKind" AS ENUM ('ACADEMIC', 'ADMINISTRATIVE');

-- CreateEnum
CREATE TYPE "OrgUnitType" AS ENUM ('INSTITUTION', 'COLLEGE', 'FACULTY', 'SCHOOL', 'DEPARTMENT', 'INSTITUTE', 'CENTRE', 'UNIT');

-- CreateEnum
CREATE TYPE "RecordStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "MfaFactorType" AS ENUM ('TOTP', 'WEBAUTHN', 'RECOVERY_CODES');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('ACTIVATION', 'PASSWORD_RESET', 'CONTACT_VERIFICATION');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('INSTITUTION', 'ORG_UNIT', 'PROGRAMME', 'COHORT', 'COURSE_OFFERING', 'HOSTEL');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "DataClass" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SENSITIVE');

-- CreateTable
CREATE TABLE "org_unit" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OrgUnitKind" NOT NULL,
    "type" "OrgUnitType" NOT NULL,
    "parent_id" UUID,
    "path" TEXT NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "org_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "mfa_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "user_agent" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_factor" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "MfaFactorType" NOT NULL,
    "label" TEXT,
    "secret_enc" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_time_token" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "channel" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "permissions" TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "scope_id" UUID,
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMPTZ(3),
    "granted_by_id" UUID,
    "reason" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT,
    "prev_hash" BYTEA NOT NULL,
    "hash" BYTEA NOT NULL,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL DEFAULT 'INSTITUTION',
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "bucket_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" BYTEA,
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'PENDING',
    "classification" "DataClass" NOT NULL DEFAULT 'CONFIDENTIAL',
    "owner_type" TEXT,
    "owner_id" UUID,
    "uploaded_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_unit_tenant_id_parent_id_idx" ON "org_unit"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "org_unit_tenant_id_path_idx" ON "org_unit"("tenant_id", "path");

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_tenant_id_id_key" ON "org_unit"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_tenant_id_code_key" ON "org_unit"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_tenant_id_id_key" ON "user_account"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_tenant_id_username_key" ON "user_account"("tenant_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_tenant_id_email_key" ON "user_account"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "session_tenant_id_user_id_idx" ON "session"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_tenant_id_id_key" ON "session"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "session_tenant_id_token_hash_key" ON "session"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "mfa_factor_tenant_id_user_id_idx" ON "mfa_factor"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factor_tenant_id_id_key" ON "mfa_factor"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "one_time_token_tenant_id_user_id_purpose_idx" ON "one_time_token"("tenant_id", "user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_token_tenant_id_id_key" ON "one_time_token"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_token_tenant_id_token_hash_key" ON "one_time_token"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_id_key" ON "role"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_key_key" ON "role"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "role_assignment_tenant_id_user_id_idx" ON "role_assignment"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignment_tenant_id_id_key" ON "role_assignment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_entity_type_entity_id_occurred_at_idx" ON "audit_event"("tenant_id", "entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_occurred_at_idx" ON "audit_event"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_tenant_id_id_key" ON "audit_event"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "outbox_event_tenant_id_published_at_idx" ON "outbox_event"("tenant_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_tenant_id_id_key" ON "outbox_event"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "setting_tenant_id_id_key" ON "setting"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "setting_tenant_id_key_scope_key_key" ON "setting"("tenant_id", "key", "scope_key");

-- CreateIndex
CREATE INDEX "file_object_tenant_id_owner_type_owner_id_idx" ON "file_object"("tenant_id", "owner_type", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_tenant_id_id_key" ON "file_object"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_tenant_id_bucket_key_key" ON "file_object"("tenant_id", "bucket_key");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_tenant_id_id_key" ON "sequence"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_tenant_id_name_key" ON "sequence"("tenant_id", "name");

-- AddForeignKey
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_token" ADD CONSTRAINT "one_time_token_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "role"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant isolation (docs/07-data-and-database.md §3) — appended to the init migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- The tenant for the current transaction, set by the app with
--   SELECT set_config('app.tenant_id', '<uuid>', true)
-- Unset → NULL → every policy comparison is NULL → no rows (fails closed).
CREATE OR REPLACE FUNCTION univarse_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Enables + FORCES RLS and (re)creates the standard tenant_isolation policy on a table.
-- Every new tenant table MUST be passed through this in its migration.
CREATE OR REPLACE FUNCTION univarse_enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = univarse_current_tenant()) '
    'WITH CHECK (tenant_id = univarse_current_tenant())', tbl);
END
$$;

SELECT univarse_enable_tenant_rls(t::regclass) FROM unnest(ARRAY[
  'org_unit', 'user_account', 'session', 'mfa_factor', 'one_time_token', 'role',
  'role_assignment', 'audit_event', 'outbox_event', 'setting', 'file_object', 'sequence'
]) AS t;

-- Append-only tables: enforced by grants, not convention (docs/07 §1).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM univarse_app;
REVOKE UPDATE, DELETE, TRUNCATE ON outbox_event FROM univarse_app;
GRANT UPDATE (published_at, attempts, last_error) ON outbox_event TO univarse_app;
