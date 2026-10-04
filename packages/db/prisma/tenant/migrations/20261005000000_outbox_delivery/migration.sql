-- Spec 0002 Part B: outbox delivery bookkeeping. Expand-only: no column is dropped.
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'DEAD');

ALTER TABLE "outbox_event"
  ADD COLUMN "product" TEXT NOT NULL DEFAULT 'core',
  ADD COLUMN "payload_enc" TEXT,
  ADD COLUMN "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "payload" DROP NOT NULL;

CREATE INDEX "outbox_event_tenant_id_status_next_attempt_at_idx" ON "outbox_event"("tenant_id", "status", "next_attempt_at");

-- Still append-only for everything else: the app may update only delivery bookkeeping.
-- payload_enc is updatable so a delivered payload can be wiped (B2).
GRANT UPDATE (status, next_attempt_at, payload_enc) ON outbox_event TO univarse_app;
