-- Spec 0028 Q2: platform identity's tables, and exactly the grants the platform API's role needs.

-- AlterTable
ALTER TABLE "platform_user" ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "locked_until" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "platform_session" ADD COLUMN "restricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "step_up_at" TIMESTAMPTZ(3),
ADD COLUMN "revoke_reason" TEXT;

-- CreateTable
CREATE TABLE "platform_mfa_factor" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "last_used_step" BIGINT,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mfa_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_recovery_code" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_mfa_challenge" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mfa_challenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_mfa_challenge_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5)
);

-- CreateTable
CREATE TABLE "platform_one_time_code" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_one_time_code_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_one_time_code_purpose_check" CHECK ("purpose" IN ('ACTIVATION', 'PASSWORD_RESET')),
    CONSTRAINT "platform_one_time_code_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5)
);

-- CreateTable
CREATE TABLE "platform_known_device" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "device_hash" BYTEA NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_known_device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_mail_outbox" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "to_address" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_mail_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_mail_outbox_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED'))
);

-- CreateIndex
CREATE INDEX "platform_mfa_factor_user_id_idx" ON "platform_mfa_factor"("user_id");
-- At most one confirmed, unrevoked factor per member.
CREATE UNIQUE INDEX "platform_mfa_factor_one_active" ON "platform_mfa_factor"("user_id") WHERE "confirmed_at" IS NOT NULL AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX "platform_recovery_code_code_hash_key" ON "platform_recovery_code"("code_hash");
CREATE INDEX "platform_recovery_code_user_id_idx" ON "platform_recovery_code"("user_id");
CREATE UNIQUE INDEX "platform_mfa_challenge_token_hash_key" ON "platform_mfa_challenge"("token_hash");
CREATE INDEX "platform_mfa_challenge_user_id_idx" ON "platform_mfa_challenge"("user_id");
CREATE INDEX "platform_one_time_code_user_id_purpose_idx" ON "platform_one_time_code"("user_id", "purpose");
CREATE UNIQUE INDEX "platform_known_device_user_id_device_hash_key" ON "platform_known_device"("user_id", "device_hash");
CREATE INDEX "platform_mail_outbox_status_next_attempt_at_idx" ON "platform_mail_outbox"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "platform_mfa_factor" ADD CONSTRAINT "platform_mfa_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_recovery_code" ADD CONSTRAINT "platform_recovery_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_mfa_challenge" ADD CONSTRAINT "platform_mfa_challenge_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_one_time_code" ADD CONSTRAINT "platform_one_time_code_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_known_device" ADD CONSTRAINT "platform_known_device_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "platform_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Privileges. The tenant API's platform role gets nothing on staff identity: the migrator's default privileges would
-- otherwise give it full DML on every one of these tables (and did, on platform_user and platform_session).
REVOKE ALL ON public.platform_user, public.platform_session, public.platform_mfa_factor, public.platform_recovery_code,
  public.platform_mfa_challenge, public.platform_one_time_code, public.platform_known_device, public.platform_mail_outbox
  FROM univarse_app_platform;

-- The console role (spec 0027 P5, spec 0028 Q2): the schema, then each table's reads, inserts, and the columns its
-- services change. No DELETE or TRUNCATE anywhere: a factor, a code or a session is retired by a timestamp.
GRANT USAGE ON SCHEMA public TO univarse_console;
GRANT SELECT, INSERT ON public.platform_user TO univarse_console;
GRANT UPDATE (password_hash, display_name, role, is_active, last_login_at, failed_login_count, locked_until, updated_at) ON public.platform_user TO univarse_console;
GRANT SELECT, INSERT ON public.platform_session TO univarse_console;
GRANT UPDATE (last_seen_at, idle_expires_at, revoked_at, revoke_reason) ON public.platform_session TO univarse_console;
GRANT SELECT, INSERT ON public.platform_mfa_factor TO univarse_console;
GRANT UPDATE (confirmed_at, last_used_step, last_used_at, revoked_at) ON public.platform_mfa_factor TO univarse_console;
GRANT SELECT, INSERT ON public.platform_recovery_code TO univarse_console;
GRANT UPDATE (used_at, revoked_at) ON public.platform_recovery_code TO univarse_console;
GRANT SELECT, INSERT ON public.platform_mfa_challenge TO univarse_console;
GRANT UPDATE (attempts, used_at, revoked_at) ON public.platform_mfa_challenge TO univarse_console;
GRANT SELECT, INSERT ON public.platform_one_time_code TO univarse_console;
GRANT UPDATE (attempts, used_at) ON public.platform_one_time_code TO univarse_console;
GRANT SELECT, INSERT ON public.platform_known_device TO univarse_console;
GRANT UPDATE (last_seen_at) ON public.platform_known_device TO univarse_console;
GRANT SELECT, INSERT ON public.platform_mail_outbox TO univarse_console;
GRANT UPDATE (status, attempts, next_attempt_at, sent_at, last_error, body) ON public.platform_mail_outbox TO univarse_console;
-- The audit chain: append and read (the chain's last row) only.
GRANT SELECT, INSERT ON public.platform_audit_event TO univarse_console;
