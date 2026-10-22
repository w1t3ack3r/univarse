-- Spec 0020 D7/D8/D14 (PR A1): one row per accepted key destruction, written in the destruction's own transaction
-- and keyed by the host protocol's operation id (`op`). Recovery reads it as the database's evidence that a destruction
-- committed (D8); `op` being the key makes a repeat a no-op, never a second destruction (D14). Append-only for the app
-- role: never updated, never deleted. Expand only (invariant 9): nothing existing changes.

CREATE TYPE "KeyDestructionKind" AS ENUM ('TENANT', 'RETIRED');

CREATE TABLE "key_destruction" (
    "op" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "KeyDestructionKind" NOT NULL,
    "versions" INTEGER[] NOT NULL,
    "reason" TEXT NOT NULL,
    "destroyed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "audit_seq" BIGINT NOT NULL,
    CONSTRAINT "key_destruction_pkey" PRIMARY KEY ("op"),
    CONSTRAINT "key_destruction_versions_nonempty" CHECK (cardinality("versions") > 0),
    CONSTRAINT "key_destruction_audit_seq_key" UNIQUE ("audit_seq")
);

CREATE INDEX "key_destruction_tenant_id_idx" ON "key_destruction"("tenant_id");

ALTER TABLE "key_destruction" ADD CONSTRAINT "key_destruction_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "key_destruction" ADD CONSTRAINT "key_destruction_audit_seq_fkey"
  FOREIGN KEY ("audit_seq") REFERENCES "platform_audit_event"("seq") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Evidence is never rewritten: the app role may only read it and add to it.
REVOKE UPDATE, DELETE, TRUNCATE ON "key_destruction" FROM univarse_app_platform;
