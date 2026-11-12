-- Spec 0034: provisioning. The job and its steps (the system of record, Q3, Q4), the DPA record (Q10), the onboarding
-- facts the worker reports (Q9), and the template a tenant was provisioned from (Q6). Expand only.

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN "template" TEXT;
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_template_check" CHECK ("template" IS NULL OR "template" ~ '^[a-z][a-z-]{1,39}@[1-9][0-9]{0,3}$');

-- CreateEnum
CREATE TYPE "ProvisioningJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'FAILED', 'DONE');
CREATE TYPE "ProvisioningStepStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "provisioning_job" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "products" TEXT[],
    "status" "ProvisioningJobStatus" NOT NULL DEFAULT 'QUEUED',
    "requested_by" UUID NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "invite_enc" TEXT,
    "invite_masked" TEXT NOT NULL,
    "error_step" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provisioning_job_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provisioning_job_template_check" CHECK ("template" ~ '^[a-z][a-z-]{1,39}$' AND "template_version" BETWEEN 1 AND 9999),
    -- The codes the console explains, and nothing else (Q4): no driver message can be stored here.
    CONSTRAINT "provisioning_job_error_check" CHECK (
      ("error_step" IS NULL AND "error_code" IS NULL)
      OR ("error_step" IN ('place', 'key', 'seed', 'template', 'host', 'products', 'invite', 'done')
          AND "error_code" IN ('no_shard', 'shard_unavailable', 'key_unavailable', 'invite_unreadable', 'state_conflict', 'database', 'unexpected'))
    ),
    -- A finished job holds no invite (Q7).
    CONSTRAINT "provisioning_job_done_check" CHECK ("status" <> 'DONE' OR ("invite_enc" IS NULL AND "finished_at" IS NOT NULL))
);

CREATE TABLE "provisioning_step" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "status" "ProvisioningStepStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error_code" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "provisioning_step_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provisioning_step_step_check" CHECK ("step" IN ('place', 'key', 'seed', 'template', 'host', 'products', 'invite', 'done')),
    CONSTRAINT "provisioning_step_error_check" CHECK (
      "error_code" IS NULL
      OR "error_code" IN ('no_shard', 'shard_unavailable', 'key_unavailable', 'invite_unreadable', 'state_conflict', 'database', 'unexpected')
    )
);

CREATE TABLE "tenant_dpa" (
    "tenant_id" UUID NOT NULL,
    "dpa_version" TEXT NOT NULL,
    "signed_on" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_dpa_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "tenant_onboarding" (
    "tenant_id" UUID NOT NULL,
    "admin_ready_at" TIMESTAMPTZ(3),
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_onboarding_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provisioning_job_tenant_id_key" ON "provisioning_job"("tenant_id");
CREATE UNIQUE INDEX "provisioning_job_requested_by_idempotency_key_key" ON "provisioning_job"("requested_by", "idempotency_key");
CREATE INDEX "provisioning_job_status_idx" ON "provisioning_job"("status");
CREATE UNIQUE INDEX "provisioning_step_job_id_step_key" ON "provisioning_step"("job_id", "step");

-- AddForeignKey
ALTER TABLE "provisioning_job" ADD CONSTRAINT "provisioning_job_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provisioning_step" ADD CONSTRAINT "provisioning_step_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "provisioning_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_dpa" ADD CONSTRAINT "tenant_dpa_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_onboarding" ADD CONSTRAINT "tenant_onboarding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Privileges. The migrator's default privileges would give the tenant API's platform role full DML on all four.
REVOKE ALL ON public.provisioning_job, public.provisioning_step, public.tenant_dpa, public.tenant_onboarding FROM univarse_app_platform;

-- The worker (Q2) runs the steps as the app's platform role: it reads the job, records each step, and wipes the invite.
GRANT SELECT ON public.provisioning_job, public.provisioning_step TO univarse_app_platform;
GRANT UPDATE (status, invite_enc, error_step, error_code, finished_at, updated_at, version) ON public.provisioning_job TO univarse_app_platform;
GRANT INSERT, UPDATE ON public.provisioning_step TO univarse_app_platform;
GRANT SELECT, INSERT, UPDATE ON public.tenant_onboarding TO univarse_app_platform;

-- The console role (Q5 step 0, Q8, Q9, Q10). It creates a tenant and its job, never reads the invite back, and
-- updates a job only to resume it. No DELETE anywhere.
GRANT INSERT (id, slug, legal_name, short_name, type, ownership, shard_id, template, updated_at) ON public.tenant TO univarse_console;
GRANT SELECT (template) ON public.tenant TO univarse_console;
GRANT UPDATE (status) ON public.tenant TO univarse_console;
GRANT INSERT (tenant_id, template, template_version, products, requested_by, idempotency_key, invite_enc, invite_masked, updated_at)
  ON public.provisioning_job TO univarse_console;
GRANT SELECT (id, tenant_id, template, template_version, products, status, requested_by, idempotency_key, invite_masked, error_step, error_code, created_at, updated_at, finished_at, version)
  ON public.provisioning_job TO univarse_console;
GRANT UPDATE (status, error_step, error_code, updated_at, version) ON public.provisioning_job TO univarse_console;
GRANT SELECT ON public.provisioning_step TO univarse_console;
GRANT SELECT, INSERT ON public.tenant_dpa TO univarse_console;
GRANT UPDATE (dpa_version, signed_on, reference, recorded_by, recorded_at, version) ON public.tenant_dpa TO univarse_console;
GRANT SELECT ON public.tenant_onboarding TO univarse_console;
