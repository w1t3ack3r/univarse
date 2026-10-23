-- Spec 0020 D8's waiver (PR A3, A3-6): one row per waiver attempt that reached W3, keyed by the attempt id the host
-- generated. It makes the waiver's platform audit event exactly-once: a repeat after a crash finds the row and returns
-- the first event's seq, never a second event. Append-only for the app role. Expand only (invariant 9).

CREATE TABLE "ledger_waiver" (
    "attempt_id" UUID NOT NULL,
    "audit_seq" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_waiver_pkey" PRIMARY KEY ("attempt_id"),
    CONSTRAINT "ledger_waiver_audit_seq_key" UNIQUE ("audit_seq")
);

ALTER TABLE "ledger_waiver" ADD CONSTRAINT "ledger_waiver_audit_seq_fkey"
  FOREIGN KEY ("audit_seq") REFERENCES "platform_audit_event"("seq") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The record of a waiver is never rewritten: the app role may only read it and add to it.
REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_waiver" FROM univarse_app_platform;
