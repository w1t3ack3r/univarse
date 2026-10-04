-- Spec 0002 A2: gap-free per-tenant position in the audit hash chain.
-- Hand-written (Prisma refuses a required column on a non-empty table non-interactively).

ALTER TABLE "audit_event" ADD COLUMN "seq" BIGINT;

-- Backfill pre-existing rows (dev/test only; production has none at this point).
-- FORCE RLS applies even to the owner, so lift it for the backfill and restore it in this same
-- migration transaction. Legacy rows keep their old hashes; they predate the chain format.
ALTER TABLE "audit_event" NO FORCE ROW LEVEL SECURITY;
UPDATE "audit_event" AS a
SET seq = s.rn
FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY occurred_at, id) AS rn FROM "audit_event") AS s
WHERE a.id = s.id;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;

ALTER TABLE "audit_event" ALTER COLUMN "seq" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_tenant_id_seq_key" ON "audit_event"("tenant_id", "seq");
