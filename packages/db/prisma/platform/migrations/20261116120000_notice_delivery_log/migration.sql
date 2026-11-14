-- Spec 0037 Q10, Q11 (E12): a notice's email to each institution's IT Admins, and the delivery log. The worker fans a
-- notice out per institution (its own queue), writing one email per IT Admin into that institution's outbox, then
-- keeps the counts here: IT Admins found, emails queued, sent and failed, banners dismissed. Counts only: no address,
-- name or user id crosses to the platform (ADR-035). Expand only.

-- AlterTable
ALTER TABLE "platform_notice_delivery" ADD COLUMN "it_admins" INTEGER;
ALTER TABLE "platform_notice_delivery" ADD COLUMN "emails_queued" INTEGER;
ALTER TABLE "platform_notice_delivery" ADD COLUMN "emails_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "platform_notice_delivery" ADD COLUMN "emails_failed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "platform_notice_delivery" ADD COLUMN "banners_dismissed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "platform_notice_delivery" ADD COLUMN "fanned_out_at" TIMESTAMPTZ(3);
ALTER TABLE "platform_notice_delivery" ADD COLUMN "counted_at" TIMESTAMPTZ(3);

ALTER TABLE "platform_notice_delivery" ADD CONSTRAINT "platform_notice_delivery_counts_check" CHECK (
  ("it_admins" IS NULL) = ("fanned_out_at" IS NULL) AND ("emails_queued" IS NULL) = ("fanned_out_at" IS NULL)
  AND COALESCE("it_admins", 0) >= 0 AND COALESCE("emails_queued", 0) BETWEEN 0 AND COALESCE("it_admins", 0)
  AND "emails_sent" >= 0 AND "emails_failed" >= 0 AND "emails_sent" + "emails_failed" <= COALESCE("emails_queued", 0)
  AND "banners_dismissed" >= 0
);

-- The worker's fan-out pass: deliveries not yet fanned out.
CREATE INDEX "platform_notice_delivery_fan_out_idx" ON "platform_notice_delivery"("created_at") WHERE "fanned_out_at" IS NULL;

-- A delivery is fanned out once.
CREATE OR REPLACE FUNCTION public.guard_platform_notice_delivery_update() RETURNS trigger
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
  IF OLD.fanned_out_at IS NOT NULL AND (NEW.fanned_out_at IS DISTINCT FROM OLD.fanned_out_at OR NEW.it_admins IS DISTINCT FROM OLD.it_admins OR NEW.emails_queued IS DISTINCT FROM OLD.emails_queued) THEN
    RAISE EXCEPTION 'a delivery is fanned out once (spec 0037 Q10)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- The counts change every few minutes; an institution's banners change only when a delivery arrives, leaves or is
-- withdrawn. So the capture fires on those alone, and a recount never empties the institutions' caches.
DROP TRIGGER platform_notice_delivery_capture_cache_invalidation ON public.platform_notice_delivery;
CREATE TRIGGER platform_notice_delivery_capture_cache_invalidation AFTER INSERT OR DELETE OR UPDATE OF withdrawn_at ON public.platform_notice_delivery
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:tenants:invalidate');
ALTER TABLE public.platform_notice_delivery ENABLE ALWAYS TRIGGER platform_notice_delivery_capture_cache_invalidation;

-- The worker (univarse_app_platform) reads what it fans out and records what happened, by column.
GRANT SELECT (created_at, fanned_out_at, it_admins, emails_queued, emails_sent, emails_failed, banners_dismissed, counted_at) ON public.platform_notice_delivery TO univarse_app_platform;
GRANT UPDATE (it_admins, emails_queued, emails_sent, emails_failed, banners_dismissed, fanned_out_at, counted_at) ON public.platform_notice_delivery TO univarse_app_platform;
