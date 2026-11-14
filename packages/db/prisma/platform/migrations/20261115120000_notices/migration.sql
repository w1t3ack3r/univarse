-- Spec 0037 Q9, Q10, Q12 (E12, E18, T34): notices to institutions, and release rings. A notice is drafted, published
-- once and never changed, then withdrawn or left to end. Publishing decides its audience once: a delivery row per
-- institution, which is also where the delivery log's counts go (Q11, PR C's second part). Each delivery row's change
-- invalidates that institution's cache (spec 0016's capture), so a published or withdrawn banner shows or leaves at
-- once. Expand only.

-- CreateEnum
CREATE TYPE "ReleaseRing" AS ENUM ('PILOT', 'GENERAL');
CREATE TYPE "NoticeKind" AS ENUM ('ANNOUNCEMENT', 'MAINTENANCE', 'RELEASE_NOTE');
CREATE TYPE "NoticeAudience" AS ENUM ('ALL', 'TENANTS', 'RING');
CREATE TYPE "NoticeStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');

-- AlterTable: Q12, every institution in the general ring until someone puts it in the pilot.
ALTER TABLE "tenant" ADD COLUMN "release_ring" "ReleaseRing" NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE "platform_notice" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kind" "NoticeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" "NoticeAudience" NOT NULL,
    "ring" "ReleaseRing",
    "tenant_ids" UUID[] NOT NULL DEFAULT '{}',
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "status" "NoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by" UUID NOT NULL,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(3),
    "shown_until" TIMESTAMPTZ(3),
    "withdrawn_by" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "platform_notice_pkey" PRIMARY KEY ("id"),
    -- T34: lengths, held by the database too. The text is stored as written and only ever shown as text.
    CONSTRAINT "platform_notice_title_check" CHECK (char_length("title") BETWEEN 1 AND 120),
    CONSTRAINT "platform_notice_body_check" CHECK (char_length("body") BETWEEN 1 AND 2000),
    CONSTRAINT "platform_notice_tenants_check" CHECK (cardinality("tenant_ids") <= 200),
    CONSTRAINT "platform_notice_ring_check" CHECK (("audience" = 'RING') = ("ring" IS NOT NULL) OR "status" = 'DRAFT'),
    CONSTRAINT "platform_notice_window_check" CHECK (
      ("kind" = 'MAINTENANCE' OR ("starts_at" IS NULL AND "ends_at" IS NULL))
      AND ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at")
    ),
    CONSTRAINT "platform_notice_published_check" CHECK (
      ("status" = 'DRAFT') = ("published_at" IS NULL) OR ("status" = 'WITHDRAWN' AND "published_at" IS NULL)
    ),
    CONSTRAINT "platform_notice_published_fields_check" CHECK (
      ("published_at" IS NULL) = ("published_by" IS NULL) AND ("published_at" IS NULL) = ("shown_until" IS NULL)
    ),
    CONSTRAINT "platform_notice_withdrawn_check" CHECK (
      ("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL) AND ("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL)
    )
);

CREATE TABLE "platform_notice_delivery" (
    "notice_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(3),

    CONSTRAINT "platform_notice_delivery_pkey" PRIMARY KEY ("notice_id", "tenant_id")
);

-- CreateIndex
CREATE INDEX "platform_notice_status_published_at_idx" ON "platform_notice"("status", "published_at");
CREATE INDEX "platform_notice_delivery_tenant_id_idx" ON "platform_notice_delivery"("tenant_id", "withdrawn_at");
CREATE INDEX "tenant_release_ring_idx" ON "tenant"("release_ring");

-- AddForeignKey
ALTER TABLE "platform_notice" ADD CONSTRAINT "platform_notice_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_notice" ADD CONSTRAINT "platform_notice_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_notice" ADD CONSTRAINT "platform_notice_withdrawn_by_fkey" FOREIGN KEY ("withdrawn_by") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_notice_delivery" ADD CONSTRAINT "platform_notice_delivery_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "platform_notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_notice_delivery" ADD CONSTRAINT "platform_notice_delivery_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Q9: a published notice never changes. DRAFT moves to PUBLISHED or WITHDRAWN (discarded), PUBLISHED to WITHDRAWN,
-- and WITHDRAWN is final. Once out of DRAFT, nothing it says, nor whom it's for, nor its window changes.
CREATE FUNCTION public.guard_platform_notice_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
       NEW.kind IS DISTINCT FROM OLD.kind OR NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.audience IS DISTINCT FROM OLD.audience OR NEW.ring IS DISTINCT FROM OLD.ring OR NEW.tenant_ids IS DISTINCT FROM OLD.tenant_ids
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by
    OR NEW.shown_until IS DISTINCT FROM OLD.shown_until) THEN
    RAISE EXCEPTION 'a published notice can''t change; publish a new one (spec 0037 Q9)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a notice''s author can''t change (spec 0037 Q9)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('PUBLISHED', 'WITHDRAWN'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'WITHDRAWN')
  ) THEN
    RAISE EXCEPTION 'a notice moves forward once (spec 0037 Q9): % to % is refused', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'WITHDRAWN' AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by) THEN
    RAISE EXCEPTION 'a notice is withdrawn once (spec 0037 Q9)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER platform_notice_guard_update BEFORE UPDATE ON public.platform_notice
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_notice_update();

-- A delivery names its notice and institution forever; only its withdrawal is written, once.
CREATE FUNCTION public.guard_platform_notice_delivery_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.notice_id IS DISTINCT FROM OLD.notice_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a notice''s audience can''t change (spec 0037 Q9)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
    RAISE EXCEPTION 'a delivery is withdrawn once (spec 0037 Q9)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER platform_notice_delivery_guard_update BEFORE UPDATE ON public.platform_notice_delivery
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_notice_delivery_update();

-- Spec 0016: a delivery's arrival or withdrawal reaches every API instance's tenant cache (where the banners live).
CREATE TRIGGER platform_notice_delivery_capture_cache_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.platform_notice_delivery
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:tenants:invalidate');
CREATE TRIGGER platform_notice_delivery_refuse_truncate BEFORE TRUNCATE ON public.platform_notice_delivery
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();
-- IO15: session_replication_role = replica must not skip them (the capture gate checks).
ALTER TABLE public.platform_notice_delivery ENABLE ALWAYS TRIGGER platform_notice_delivery_capture_cache_invalidation;
ALTER TABLE public.platform_notice_delivery ENABLE ALWAYS TRIGGER platform_notice_delivery_refuse_truncate;

-- Privileges. The migrator's default privileges would give the tenant API's platform role full DML: start from none.
REVOKE ALL ON public.platform_notice, public.platform_notice_delivery FROM univarse_app_platform;

-- The console role drafts, publishes and withdraws. It never sets the status, publisher or withdrawer on insert,
-- never deletes, and can't change a published notice (the trigger).
GRANT SELECT ON public.platform_notice, public.platform_notice_delivery TO univarse_console;
GRANT INSERT (kind, title, body, audience, ring, tenant_ids, starts_at, ends_at, created_by, updated_at) ON public.platform_notice TO univarse_console;
GRANT UPDATE (kind, title, body, audience, ring, tenant_ids, starts_at, ends_at, status, published_by, published_at, shown_until, withdrawn_by, withdrawn_at, updated_at, version) ON public.platform_notice TO univarse_console;
GRANT INSERT (notice_id, tenant_id) ON public.platform_notice_delivery TO univarse_console;
GRANT UPDATE (withdrawn_at) ON public.platform_notice_delivery TO univarse_console;
GRANT SELECT (release_ring) ON public.tenant TO univarse_console;
GRANT UPDATE (release_ring) ON public.tenant TO univarse_console;

-- The tenant API reads what an institution's banners need, by column: never who wrote or published it.
GRANT SELECT (id, kind, title, body, starts_at, ends_at, status, published_at, shown_until) ON public.platform_notice TO univarse_app_platform;
GRANT SELECT (notice_id, tenant_id, withdrawn_at) ON public.platform_notice_delivery TO univarse_app_platform;
