-- Spec 0032: changing a member's address. Whether an address is proven, a password that must be replaced after an undo,
-- and each change, whose addresses are blanked once they're no longer needed (Q12). Expand only.

-- CreateEnum
CREATE TYPE "PlatformContactChannel" AS ENUM ('EMAIL');
CREATE TYPE "PlatformContactChangeKind" AS ENUM ('SELF', 'ADMIN', 'COMMAND');
CREATE TYPE "PlatformContactChangeStatus" AS ENUM ('PENDING', 'REPLACED', 'CONFIRMED', 'UNDONE');

-- AlterTable
ALTER TABLE "platform_user" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);
ALTER TABLE "platform_user" ADD COLUMN "password_reset_required" BOOLEAN NOT NULL DEFAULT false;

-- Q11: an activated member proved their address by activating.
UPDATE "platform_user" SET "email_verified_at" = "updated_at" WHERE "password_hash" IS NOT NULL;

-- CreateTable
CREATE TABLE "platform_contact_change" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "channel" "PlatformContactChannel" NOT NULL DEFAULT 'EMAIL',
    "kind" "PlatformContactChangeKind" NOT NULL,
    "status" "PlatformContactChangeStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by" UUID,
    "new_address" TEXT,
    "old_address" TEXT,
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

    CONSTRAINT "platform_contact_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_contact_change_user_id_created_at_idx" ON "platform_contact_change"("user_id", "created_at");
CREATE INDEX "platform_contact_change_new_address_idx" ON "platform_contact_change"("new_address");
CREATE INDEX "platform_contact_change_old_address_idx" ON "platform_contact_change"("old_address");
CREATE INDEX "platform_contact_change_blanked_at_idx" ON "platform_contact_change"("blanked_at");

-- AddForeignKey
ALTER TABLE "platform_contact_change" ADD CONSTRAINT "platform_contact_change_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Privileges. The migrator's default privileges would give the tenant API's platform role full DML here.
REVOKE ALL ON public.platform_contact_change FROM univarse_app_platform;

-- The console role: a change is written and moved along; a row stays, only its addresses and codes go (Q12). No DELETE.
GRANT SELECT, INSERT ON public.platform_contact_change TO univarse_console;
GRANT UPDATE (status, new_address, old_address, code_hash, attempts, confirmed_at, undo_hash, undo_until, undo_attempts, undone_at, blanked_at) ON public.platform_contact_change TO univarse_console;
GRANT UPDATE (email, email_verified_at, password_reset_required) ON public.platform_user TO univarse_console;
