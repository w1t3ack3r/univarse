-- Spec 0038 Q8, Q-B7 (PR B): what the platform knows of an institution's exports: their state, dates, size and counts,
-- never their content or passphrase. The worker mirrors them from the institution's own `data_export`; the console
-- reads them (A2: it holds no tenant credential). Expand only.

-- CreateTable
CREATE TABLE "platform_tenant_export" (
    -- The institution's own export id.
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "failed_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    "size_bytes" BIGINT,
    "tables" INTEGER,
    "rows" BIGINT,
    "files" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_tenant_export_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_tenant_export_state_check" CHECK ("state" IN ('REQUESTED', 'BUILDING', 'READY', 'FAILED', 'EXPIRED'))
);

-- CreateIndex
CREATE INDEX "platform_tenant_export_tenant_id_requested_at_idx" ON "platform_tenant_export"("tenant_id", "requested_at");
-- Q-B10: the expiry pass reads the ready ones by their end.
CREATE INDEX "platform_tenant_export_ready_idx" ON "platform_tenant_export"("expires_at") WHERE "state" = 'READY';

-- AddForeignKey
ALTER TABLE "platform_tenant_export" ADD CONSTRAINT "platform_tenant_export_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A mirror names its institution for good.
CREATE FUNCTION public.guard_platform_tenant_export_update() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'an export''s institution can''t change (spec 0038 Q8)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_tenant_export_guard_update BEFORE UPDATE ON public.platform_tenant_export
  FOR EACH ROW EXECUTE FUNCTION public.guard_platform_tenant_export_update();

-- Privileges. The worker (the tenant side's platform role) writes the mirror; the console only reads it.
REVOKE ALL ON public.platform_tenant_export FROM univarse_app_platform;
GRANT SELECT, INSERT, UPDATE ON public.platform_tenant_export TO univarse_app_platform;
GRANT SELECT ON public.platform_tenant_export TO univarse_console;
