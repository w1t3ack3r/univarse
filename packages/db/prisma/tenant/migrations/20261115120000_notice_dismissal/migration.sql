-- Spec 0037 Q10: a person hides a notice's banner for themselves. Recorded here, at the institution, never on the
-- platform (ADR-035: the platform knows how many, never who). The notice id names a platform row; no foreign key
-- crosses databases. Expand only.

-- CreateTable
CREATE TABLE "notice_dismissal" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notice_id" UUID NOT NULL,
    "dismissed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_dismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: one dismissal per person and notice; the delivery log counts them per notice (Q11).
CREATE UNIQUE INDEX "notice_dismissal_tenant_id_id_key" ON "notice_dismissal"("tenant_id", "id");
CREATE UNIQUE INDEX "notice_dismissal_tenant_id_user_id_notice_id_key" ON "notice_dismissal"("tenant_id", "user_id", "notice_id");
CREATE INDEX "notice_dismissal_tenant_id_notice_id_idx" ON "notice_dismissal"("tenant_id", "notice_id");

-- AddForeignKey
ALTER TABLE "notice_dismissal" ADD CONSTRAINT "notice_dismissal_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user_account"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation: forced RLS, as every tenant table (docs/07 §3).
SELECT univarse_enable_tenant_rls('notice_dismissal'::regclass);

-- A dismissal is a fact: it isn't changed or removed (an account's removal takes its own with it).
REVOKE UPDATE, DELETE, TRUNCATE ON notice_dismissal FROM univarse_app;
