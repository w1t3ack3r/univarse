-- Spec 0042 (P2-S1): the org tree. The institution's own unit types (projected from its profile snapshot), the code
-- reservations, the effective-dated history, the tree's and the code lock's own rules, and the new permissions.
-- Expand only (Q16): `org_unit.kind`, `type` and `status` stay, still written with values the earlier images read.
-- Wrapped in one transaction (spec 0039 Q-A3): Prisma doesn't roll a failed PostgreSQL migration back by itself.
BEGIN;

-- CreateEnum
CREATE TYPE "OrgUnitStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');
CREATE TYPE "UnitTypeKind" AS ENUM ('ACADEMIC', 'ADMINISTRATIVE', 'RESEARCH');
CREATE TYPE "OrgUnitChangeKind" AS ENUM ('CREATED', 'RENAMED', 'DESCRIBED', 'RETYPED', 'MOVED', 'CODE_CHANGED', 'CODE_CORRECTED', 'DEACTIVATED', 'ARCHIVED', 'REACTIVATED');

-- AlterTable: Q8 a code is optional until assigned; Q5 the unit's own status; Q9 the lock; Q-A2 the create's key.
ALTER TABLE "org_unit" ADD COLUMN "code_locked_at" TIMESTAMPTZ(3),
ADD COLUMN "creation_key" UUID,
ADD COLUMN "description" TEXT,
ADD COLUMN "state" "OrgUnitStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "type_id" UUID,
ALTER COLUMN "code" DROP NOT NULL;

-- CreateTable
CREATE TABLE "org_unit_type" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "UnitTypeKind" NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "org_unit_type_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "org_unit_type_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$'),
    CONSTRAINT "org_unit_type_name_check" CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60),
    CONSTRAINT "org_unit_type_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "org_unit_type_rule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "parent_type_id" UUID NOT NULL,
    "child_type_id" UUID NOT NULL,

    CONSTRAINT "org_unit_type_rule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "org_unit_code" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "unit_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_unit_code_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "org_unit_code_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9]{1,11}$')
);

CREATE TABLE "org_unit_change" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" "OrgUnitChangeKind" NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type_id" UUID,
    "parent_id" UUID,
    "state" "OrgUnitStatus" NOT NULL,
    "effective_from" DATE NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_unit_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "org_unit_change_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500)
);

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_type_tenant_id_id_key" ON "org_unit_type"("tenant_id", "id");
CREATE UNIQUE INDEX "org_unit_type_tenant_id_key_key" ON "org_unit_type"("tenant_id", "key");
CREATE UNIQUE INDEX "org_unit_type_rule_tenant_id_id_key" ON "org_unit_type_rule"("tenant_id", "id");
CREATE UNIQUE INDEX "org_unit_type_rule_tenant_id_parent_type_id_child_type_id_key" ON "org_unit_type_rule"("tenant_id", "parent_type_id", "child_type_id");
CREATE INDEX "org_unit_code_tenant_id_unit_id_idx" ON "org_unit_code"("tenant_id", "unit_id");
CREATE UNIQUE INDEX "org_unit_code_tenant_id_id_key" ON "org_unit_code"("tenant_id", "id");
CREATE UNIQUE INDEX "org_unit_code_tenant_id_code_key" ON "org_unit_code"("tenant_id", "code");
CREATE UNIQUE INDEX "org_unit_code_tenant_id_unit_id_code_key" ON "org_unit_code"("tenant_id", "unit_id", "code");
CREATE INDEX "org_unit_change_tenant_id_unit_id_effective_from_seq_idx" ON "org_unit_change"("tenant_id", "unit_id", "effective_from", "seq");
CREATE INDEX "org_unit_change_tenant_id_effective_from_idx" ON "org_unit_change"("tenant_id", "effective_from");
CREATE UNIQUE INDEX "org_unit_change_tenant_id_id_key" ON "org_unit_change"("tenant_id", "id");
CREATE UNIQUE INDEX "org_unit_tenant_id_creation_key_key" ON "org_unit"("tenant_id", "creation_key");
-- Q4: one root per institution.
CREATE UNIQUE INDEX "org_unit_one_root_key" ON "org_unit"("tenant_id") WHERE "parent_id" IS NULL;

-- AddForeignKey
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_tenant_id_type_id_fkey" FOREIGN KEY ("tenant_id", "type_id") REFERENCES "org_unit_type"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "org_unit_type_rule" ADD CONSTRAINT "org_unit_type_rule_tenant_id_parent_type_id_fkey" FOREIGN KEY ("tenant_id", "parent_type_id") REFERENCES "org_unit_type"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "org_unit_type_rule" ADD CONSTRAINT "org_unit_type_rule_tenant_id_child_type_id_fkey" FOREIGN KEY ("tenant_id", "child_type_id") REFERENCES "org_unit_type"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A unit's reservations and history go with it: only the purge (the migrator) deletes a unit (the app can't, Q5).
ALTER TABLE "org_unit_code" ADD CONSTRAINT "org_unit_code_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE "org_unit_change" ADD CONSTRAINT "org_unit_change_tenant_id_unit_id_fkey" FOREIGN KEY ("tenant_id", "unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- ─── Backfill, before any of the new rules exist. FORCE RLS binds the owner too, so it's lifted for these statements
-- and restored below in the same transaction (as 20261004000000_audit_seq did). The new tables get RLS after them.
ALTER TABLE "org_unit" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "institution_profile" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "role" NO FORCE ROW LEVEL SECURITY;

-- Q1: each institution's unit types from its latest profile snapshot (spec 0041 Q4), in the profile's order.
INSERT INTO "org_unit_type" ("tenant_id", "key", "name", "kind", "sort_order", "updated_at")
SELECT l."tenant_id", t->>'key', t->>'name', upper(t->>'kind')::"UnitTypeKind", (u.ord - 1)::int, CURRENT_TIMESTAMP
FROM (SELECT DISTINCT ON ("tenant_id") "tenant_id", "profile" FROM "institution_profile" ORDER BY "tenant_id", "template_version" DESC, "assigned_at" DESC) l,
     jsonb_array_elements(l."profile"->'unitTypes') WITH ORDINALITY AS u(t, ord);

INSERT INTO "org_unit_type_rule" ("tenant_id", "parent_type_id", "child_type_id")
SELECT l."tenant_id", p."id", c."id"
FROM (SELECT DISTINCT ON ("tenant_id") "tenant_id", "profile" FROM "institution_profile" ORDER BY "tenant_id", "template_version" DESC, "assigned_at" DESC) l
CROSS JOIN LATERAL jsonb_array_elements(l."profile"->'unitTypes') AS t
CROSS JOIN LATERAL jsonb_array_elements_text(t->'mayContain') AS ck
JOIN "org_unit_type" p ON p."tenant_id" = l."tenant_id" AND p."key" = t->>'key'
JOIN "org_unit_type" c ON c."tenant_id" = l."tenant_id" AND c."key" = ck;

-- A unit other than a root, from before the tree's screens (none on the stack; tests clean theirs up): its old type
-- becomes a type of the institution's, if the institution doesn't have it.
INSERT INTO "org_unit_type" ("tenant_id", "key", "name", "kind", "sort_order", "updated_at")
SELECT DISTINCT u."tenant_id", lower(u."type"::text), initcap(lower(u."type"::text)), u."kind"::text::"UnitTypeKind", 1000, CURRENT_TIMESTAMP
FROM "org_unit" u WHERE u."parent_id" IS NOT NULL
ON CONFLICT ("tenant_id", "key") DO NOTHING;

UPDATE "org_unit" u SET "type_id" = t."id"
FROM "org_unit_type" t
WHERE u."parent_id" IS NOT NULL AND t."tenant_id" = u."tenant_id" AND t."key" = lower(u."type"::text);

UPDATE "org_unit" SET "state" = 'ARCHIVED' WHERE "status" = 'ARCHIVED';

-- Q8: every code in use is reserved. (Every institution's root holds `ROOT`. A code from before the format, which only
-- an old test's leftovers in a development database have, isn't reserved: see the NOT VALID checks below.)
INSERT INTO "org_unit_code" ("tenant_id", "code", "unit_id")
SELECT "tenant_id", "code", "id" FROM "org_unit" WHERE "code" ~ '^[A-Z][A-Z0-9]{1,11}$';

-- Q6: each unit's history starts with its creation, parents before children.
INSERT INTO "org_unit_change" ("tenant_id", "unit_id", "kind", "code", "name", "description", "type_id", "parent_id", "state", "effective_from")
SELECT "tenant_id", "id", 'CREATED', "code", "name", "description", "type_id", "parent_id", "state", ("created_at" AT TIME ZONE 'Africa/Lagos')::date
FROM "org_unit" ORDER BY char_length("path"), "id";

-- Q12: the new permissions for the seeded system roles (the seed's SYSTEM_ROLE_PERMISSIONS says the same).
UPDATE "role" r
SET "permissions" = r."permissions" || ARRAY(SELECT p FROM unnest(g.add) AS p WHERE NOT (p = ANY (r."permissions"))), "updated_at" = CURRENT_TIMESTAMP
FROM (VALUES
  ('INSTITUTION_ADMIN', ARRAY['org.unit.restructure', 'org.unit_type.manage']::text[]),
  ('REGISTRAR', ARRAY['org.unit.manage', 'org.unit.restructure', 'org.unit_type.manage']::text[]),
  ('MANAGEMENT_VIEWER', ARRAY['org.unit.view']::text[])
) AS g(key, add)
WHERE r."key" = g.key AND r."is_system" AND NOT (g.add <@ r."permissions");

ALTER TABLE "org_unit" FORCE ROW LEVEL SECURITY;
ALTER TABLE "institution_profile" FORCE ROW LEVEL SECURITY;
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;

-- ─── The rules the database holds itself. The code's two are NOT VALID: they bind every row written from now on and
-- leave rows from before untouched (expand only); the contract release validates them.
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_code_check" CHECK ("code" IS NULL OR "code" ~ '^[A-Z][A-Z0-9]{1,11}$') NOT VALID;
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_description_check" CHECK ("description" IS NULL OR char_length("description") BETWEEN 1 AND 500);
-- Q4: the root, and only the root, has no unit type.
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_type_root_check" CHECK (("parent_id" IS NULL) = ("type_id" IS NULL));
-- Q8: a unit's current code is one of its reservations. Deferred: a correction swaps the two rows in one transaction.
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_code_reserved_fkey" FOREIGN KEY ("tenant_id", "id", "code") REFERENCES "org_unit_code"("tenant_id", "unit_id", "code") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED NOT VALID;

-- Q3, Q11: checked at commit, because a move rewrites a whole subtree's paths in one statement. A unit's path is its
-- parent's plus its own id (so a cycle can't be stored); a unit placed or moved, or made active again, sits under an
-- active parent whose type may contain its own (the root takes every type).
CREATE FUNCTION univarse_org_unit_tree_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur "org_unit"%ROWTYPE;
  par "org_unit"%ROWTYPE;
  placed boolean := TG_OP = 'INSERT';
  reopened boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    placed := OLD."parent_id" IS DISTINCT FROM NEW."parent_id" OR OLD."type_id" IS DISTINCT FROM NEW."type_id";
    reopened := OLD."state" <> 'ACTIVE' AND NEW."state" = 'ACTIVE';
  END IF;
  -- The row as it is now, at commit (it may have changed again since this event).
  SELECT * INTO cur FROM "org_unit" WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF cur."parent_id" IS NULL THEN
    IF cur."path" <> '/' || cur."id" || '/' THEN
      RAISE EXCEPTION 'org_unit %: the root''s path must be its own id', cur."id" USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO par FROM "org_unit" WHERE "tenant_id" = cur."tenant_id" AND "id" = cur."parent_id";
  IF NOT FOUND OR cur."path" <> par."path" || cur."id" || '/' THEN
    RAISE EXCEPTION 'org_unit %: its path must be its parent''s plus its own id', cur."id" USING ERRCODE = 'check_violation';
  END IF;
  IF (placed OR reopened) AND cur."state" <> 'ARCHIVED' AND par."state" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'org_unit %: its parent isn''t active', cur."id" USING ERRCODE = 'check_violation';
  END IF;
  IF placed AND par."type_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "org_unit_type_rule" r
                     WHERE r."tenant_id" = cur."tenant_id" AND r."parent_type_id" = par."type_id" AND r."child_type_id" = cur."type_id") THEN
    RAISE EXCEPTION 'org_unit %: its parent''s type may not contain its type', cur."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "org_unit_tree_check"
AFTER INSERT OR UPDATE OF "parent_id", "path", "type_id", "state" ON "org_unit"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION univarse_org_unit_tree_check();

-- Q9: a lock is never cleared, and a locked unit always has a code.
CREATE FUNCTION univarse_org_unit_lock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."code_locked_at" IS NOT NULL AND NEW."code_locked_at" IS DISTINCT FROM OLD."code_locked_at" THEN
    RAISE EXCEPTION 'org_unit %: a code lock is never cleared or changed', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."code_locked_at" IS NOT NULL AND NEW."code" IS NULL THEN
    RAISE EXCEPTION 'org_unit %: a locked unit keeps a code', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "org_unit_lock_guard" BEFORE UPDATE ON "org_unit" FOR EACH ROW EXECUTE FUNCTION univarse_org_unit_lock_guard();

-- Q9: a locked unit's codes stay reserved for ever, so a changed locked code can't come to mean another unit. A unit
-- deleted by the purge takes its reservations with it (the cascade runs once the unit's row is gone).
CREATE FUNCTION univarse_org_unit_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'org_unit_code %: a reservation is never changed', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "org_unit" u WHERE u."tenant_id" = OLD."tenant_id" AND u."id" = OLD."unit_id" AND u."code_locked_at" IS NOT NULL) THEN
    RAISE EXCEPTION 'org_unit_code %: a locked unit''s code stays reserved', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER "org_unit_code_guard" BEFORE UPDATE OR DELETE ON "org_unit_code" FOR EACH ROW EXECUTE FUNCTION univarse_org_unit_code_guard();

-- Tenant isolation: forced RLS, as every tenant table (docs/07 §3).
SELECT univarse_enable_tenant_rls('org_unit_type'::regclass);
SELECT univarse_enable_tenant_rls('org_unit_type_rule'::regclass);
SELECT univarse_enable_tenant_rls('org_unit_code'::regclass);
SELECT univarse_enable_tenant_rls('org_unit_change'::regclass);

-- What the app may do. Q5: no unit is ever deleted; Q2: a type is archived, never deleted; a rule is added or
-- removed; a reservation is added or released, never changed; Q6: the history is append-only.
REVOKE DELETE, TRUNCATE ON org_unit FROM univarse_app;
REVOKE DELETE, TRUNCATE ON org_unit_type FROM univarse_app;
REVOKE UPDATE, TRUNCATE ON org_unit_type_rule FROM univarse_app;
REVOKE UPDATE, TRUNCATE ON org_unit_code FROM univarse_app;
REVOKE UPDATE, DELETE, TRUNCATE ON org_unit_change FROM univarse_app;

COMMIT;
