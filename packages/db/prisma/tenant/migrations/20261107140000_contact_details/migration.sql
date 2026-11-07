-- Spec 0032: changing a user's address. Whether an address is proven, a password that must be replaced after an undo,
-- and each change: addresses under the field encryption, with a keyed hash to find them by, blanked once they're no
-- longer needed (Q12). Expand only.

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('EMAIL');
CREATE TYPE "ContactChangeKind" AS ENUM ('SELF', 'ADMIN');
CREATE TYPE "ContactChangeStatus" AS ENUM ('PENDING', 'REPLACED', 'CONFIRMED', 'UNDONE');

-- AlterTable
ALTER TABLE "user_account" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);
ALTER TABLE "user_account" ADD COLUMN "password_reset_required" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "contact_change" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "ContactChannel" NOT NULL DEFAULT 'EMAIL',
    "kind" "ContactChangeKind" NOT NULL,
    "status" "ContactChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID,
    "new_address_enc" TEXT,
    "old_address_enc" TEXT,
    "new_address_hash" BYTEA,
    "old_address_hash" BYTEA,
    "old_address_wrong" BOOLEAN NOT NULL DEFAULT false,
    "code_hash" BYTEA,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "undo_hash" BYTEA,
    "undo_until" TIMESTAMPTZ(3),
    "undo_attempts" INTEGER NOT NULL DEFAULT 0,
    "undone_at" TIMESTAMPTZ(3),
    "blanked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contact_change_tenant_id_id_key" ON "contact_change"("tenant_id", "id");
CREATE INDEX "contact_change_tenant_id_user_id_created_at_idx" ON "contact_change"("tenant_id", "user_id", "created_at");
CREATE INDEX "contact_change_tenant_id_new_address_hash_idx" ON "contact_change"("tenant_id", "new_address_hash");
CREATE INDEX "contact_change_tenant_id_old_address_hash_idx" ON "contact_change"("tenant_id", "old_address_hash");
CREATE INDEX "contact_change_tenant_id_blanked_at_idx" ON "contact_change"("tenant_id", "blanked_at");

-- AddForeignKey
ALTER TABLE "contact_change" ADD CONSTRAINT "contact_change_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Spec 0032 Q11: an activated user who has an address proved it by activating. An imported one hasn't, until then.
-- The table's own policy holds: this migration runs as the owner, across every tenant on the shard.
UPDATE "user_account" SET "email_verified_at" = "updated_at" WHERE "email" IS NOT NULL AND "password_hash" IS NOT NULL;

-- Tenant isolation: forced RLS, as every tenant table (docs/07 §3).
SELECT univarse_enable_tenant_rls('contact_change'::regclass);

-- A row is the record that a change happened: it's moved along, never removed.
REVOKE DELETE, TRUNCATE ON contact_change FROM univarse_app;
