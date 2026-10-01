-- AlterTable
ALTER TABLE "mfa_factor" ADD COLUMN     "last_used_step" BIGINT;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "step_up_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "mfa_challenge" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_code" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mfa_challenge_tenant_id_user_id_idx" ON "mfa_challenge"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenge_tenant_id_id_key" ON "mfa_challenge"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenge_tenant_id_token_hash_key" ON "mfa_challenge"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "recovery_code_tenant_id_user_id_idx" ON "recovery_code"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_code_tenant_id_id_key" ON "recovery_code"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_code_tenant_id_code_hash_key" ON "recovery_code"("tenant_id", "code_hash");

-- AddForeignKey
ALTER TABLE "mfa_challenge" ADD CONSTRAINT "mfa_challenge_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant isolation for the new tables (docs/07 §3). Same helper as the init migration.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT univarse_enable_tenant_rls(t::regclass) FROM unnest(ARRAY['mfa_challenge', 'recovery_code']) AS t;

-- Defence in depth for the attempt budget (spec 0001 M6/M12): the app reserves attempts with a
-- conditional UPDATE; the database refuses to go past the budget even if that code regresses.
ALTER TABLE mfa_challenge ADD CONSTRAINT mfa_challenge_attempts_budget CHECK (attempts BETWEEN 0 AND 5);
