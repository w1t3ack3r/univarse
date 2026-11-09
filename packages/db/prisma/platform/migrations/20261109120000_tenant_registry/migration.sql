-- Spec 0033: the tenant registry. Two tables of the platform's own, and the console role's first real access to an
-- institution's record, by column, so the secrets beside it can't be selected at all (Q3). Expand only.

-- CreateEnum
CREATE TYPE "TenantOperatingStatus" AS ENUM ('UNKNOWN', 'APPROVED', 'PROVISIONAL_LICENCE', 'SUSPENDED_BY_REGULATOR');

-- CreateTable
CREATE TABLE "tenant_regulatory_profile" (
    "tenant_id" UUID NOT NULL,
    "operating_status" "TenantOperatingStatus" NOT NULL DEFAULT 'UNKNOWN',
    "state" TEXT,
    "regulator_reference" TEXT,
    "jamb_code" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_regulatory_profile_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "tenant_branding" (
    "tenant_id" UUID NOT NULL,
    "primary_color" TEXT,
    "logo" BYTEA,
    "logo_mime" TEXT,
    "logo_sha256" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_branding_primary_color_check" CHECK ("primary_color" IS NULL OR "primary_color" ~ '^#[0-9A-F]{6}$'),
    -- The same limits as the application's, so a bug there can't store something else (Q9).
    CONSTRAINT "tenant_branding_logo_check" CHECK (
      ("logo" IS NULL AND "logo_mime" IS NULL AND "logo_sha256" IS NULL)
      OR ("logo" IS NOT NULL AND "logo_mime" IN ('image/png', 'image/webp') AND "logo_sha256" ~ '^[0-9a-f]{64}$' AND octet_length("logo") <= 262144)
    )
);

-- AddForeignKey
ALTER TABLE "tenant_regulatory_profile" ADD CONSTRAINT "tenant_regulatory_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Q12: a new colour or logo reaches every instance as the other tenant tables' changes do.
CREATE TRIGGER tenant_branding_capture_cache_invalidation AFTER INSERT OR UPDATE OR DELETE ON public.tenant_branding
  FOR EACH ROW EXECUTE FUNCTION public.capture_cache_invalidation('uv:tenants:invalidate');
CREATE TRIGGER tenant_branding_refuse_truncate BEFORE TRUNCATE ON public.tenant_branding
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_cache_table_truncate();
ALTER TABLE public.tenant_branding ENABLE ALWAYS TRIGGER tenant_branding_capture_cache_invalidation;
ALTER TABLE public.tenant_branding ENABLE ALWAYS TRIGGER tenant_branding_refuse_truncate;

-- Privileges. The migrator's default privileges would give the tenant API's platform role full DML on both.
REVOKE ALL ON public.tenant_regulatory_profile, public.tenant_branding FROM univarse_app_platform;

-- The tenant API shows a logo and colour on an institution's own pages (Q11), and reads nothing else here.
GRANT SELECT (tenant_id, primary_color, logo, logo_mime, logo_sha256) ON public.tenant_branding TO univarse_app_platform;

-- The console role. Its own two tables, without DELETE.
GRANT SELECT, INSERT ON public.tenant_regulatory_profile, public.tenant_branding TO univarse_console;
GRANT UPDATE (operating_status, state, regulator_reference, jamb_code, version, updated_by, updated_at) ON public.tenant_regulatory_profile TO univarse_console;
GRANT UPDATE (primary_color, logo, logo_mime, logo_sha256, updated_by, updated_at) ON public.tenant_branding TO univarse_console;

-- Q3: named columns only. Not among them: shard.secret_ref, tenant_domain.verification_token, tenant_data_key.wrapped_dek.
GRANT SELECT (legal_name, type, ownership, status, tier, shard_id, suspended_reason, offboarding_started_at, purge_after, created_at, updated_at, version) ON public.tenant TO univarse_console;
GRANT UPDATE (legal_name, short_name, type, ownership, version, updated_at) ON public.tenant TO univarse_console;
GRANT SELECT (id, name, kind, region, is_active) ON public.shard TO univarse_console;
GRANT SELECT (id, tenant_id, hostname, kind, verified_at, created_at) ON public.tenant_domain TO univarse_console;
GRANT SELECT (id, tenant_id, version, status, kek_id, created_at, retired_at, destroyed_at) ON public.tenant_data_key TO univarse_console;

-- Q13: only platform code writes `entitled` (spec 0003 P9), and this is platform code.
GRANT SELECT, INSERT ON public.tenant_product TO univarse_console;
GRANT UPDATE (entitled, enabled, updated_by, updated_at) ON public.tenant_product TO univarse_console;
