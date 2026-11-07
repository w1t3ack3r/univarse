-- Spec 0031: seeing what happened. The audit chain's verification runs, security events as per-minute counts, and the
-- monthly access reviews.

-- CreateEnum
CREATE TYPE "PlatformVerificationTrigger" AS ENUM ('MEMBER', 'SCHEDULE');
CREATE TYPE "PlatformVerificationStatus" AS ENUM ('RUNNING', 'PASSED', 'FAILED', 'ERROR');

-- CreateTable
CREATE TABLE "platform_audit_verification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "trigger" "PlatformVerificationTrigger" NOT NULL,
    "started_by" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "status" "PlatformVerificationStatus" NOT NULL DEFAULT 'RUNNING',
    "rows_checked" BIGINT NOT NULL DEFAULT 0,
    "head_seq" BIGINT,
    "head_hash" BYTEA,
    "broken_at_seq" BIGINT,
    "reason" TEXT,

    CONSTRAINT "platform_audit_verification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_security_event_rollup" (
    "minute" TIMESTAMPTZ(0) NOT NULL,
    "event" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "count" INTEGER NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_security_event_rollup_pkey" PRIMARY KEY ("minute", "event", "source", "tenant_id")
);

CREATE TABLE "platform_access_review" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "period" TEXT NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "attested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,
    "snapshot_hash" BYTEA NOT NULL,

    CONSTRAINT "platform_access_review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_verification_started_at_idx" ON "platform_audit_verification"("started_at");
CREATE INDEX "platform_security_event_rollup_minute_idx" ON "platform_security_event_rollup"("minute");
CREATE INDEX "platform_security_event_rollup_tenant_id_minute_idx" ON "platform_security_event_rollup"("tenant_id", "minute");
CREATE UNIQUE INDEX "platform_access_review_period_key" ON "platform_access_review"("period");

-- The viewer's filters, newest first. The chain's own unique index on seq serves the unfiltered list.
CREATE INDEX "platform_audit_event_action_seq_idx" ON "platform_audit_event"("action", "seq" DESC);
CREATE INDEX "platform_audit_event_actor_id_seq_idx" ON "platform_audit_event"("actor_id", "seq" DESC);

-- Privileges. The migrator's default privileges would give the tenant API's platform role full DML on all three.
REVOKE ALL ON public.platform_audit_verification, public.platform_security_event_rollup, public.platform_access_review FROM univarse_app_platform;

-- The console role: a verification run is written and finished; a review is written once and never changed. No DELETE.
GRANT SELECT, INSERT ON public.platform_audit_verification TO univarse_console;
GRANT UPDATE (finished_at, status, rows_checked, head_seq, head_hash, broken_at_seq, reason) ON public.platform_audit_verification TO univarse_console;
GRANT SELECT, INSERT ON public.platform_access_review TO univarse_console;

-- The rollups: every process that logs security events adds to them. ON CONFLICT DO UPDATE needs SELECT on the columns
-- it reads, so the tenant API's role holds that and nothing else there: no rollup holds personal data (Q8).
GRANT SELECT, INSERT ON public.platform_security_event_rollup TO univarse_console;
GRANT UPDATE ("count", last_seen_at) ON public.platform_security_event_rollup TO univarse_console;
GRANT SELECT (minute, event, source, tenant_id, "count", last_seen_at), INSERT ON public.platform_security_event_rollup TO univarse_app_platform;
GRANT UPDATE ("count", last_seen_at) ON public.platform_security_event_rollup TO univarse_app_platform;

-- Q13: the security page names institutions by slug. Those columns only: never a status, contract or any other detail.
GRANT SELECT (id, slug, short_name) ON public.tenant TO univarse_console;
