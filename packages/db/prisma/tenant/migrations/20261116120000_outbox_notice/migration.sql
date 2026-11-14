-- Spec 0037 Q10, Q11: a notice's emails, in the institution's outbox like every email, named by the notice they carry.
-- The worker counts them per notice for the platform's delivery log (counts only), and a suspended institution's
-- outbox still delivers these (Q8) while it holds everything else. Expand only.

-- AlterTable
ALTER TABLE "outbox_event" ADD COLUMN "notice_id" UUID;

-- CreateIndex
CREATE INDEX "outbox_event_tenant_id_notice_id_idx" ON "outbox_event"("tenant_id", "notice_id") WHERE "notice_id" IS NOT NULL;
