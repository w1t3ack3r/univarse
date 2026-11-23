-- Spec 0039 PR A (S8): database servers and their connection budget, a shard's server, database, capacity, pool size
-- and status, and a migration run per database per migrate job. The bootstrap's server (`local`) and pool (`pool-01`)
-- are registered here, so every environment that runs the migrations has them before the per-shard runner looks.
-- Expand only: `shard.is_active` stays, unused, until a later release drops it.

CREATE TYPE "ShardStatus" AS ENUM ('READY', 'ACTIVE', 'MAINTENANCE', 'RETIRED');
CREATE TYPE "MigrationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "db_server" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "max_connections" INTEGER NOT NULL,
    "reserved_connections" INTEGER NOT NULL,
    "secret_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "db_server_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "db_server_name_check" CHECK ("name" ~ '^[a-z][a-z0-9-]{1,30}$'),
    -- Q2: the prefix of its URL templates' variable names (<prefix>_APP_URL, <prefix>_MIGRATOR_URL), never a URL.
    CONSTRAINT "db_server_secret_ref_check" CHECK ("secret_ref" ~ '^DB_SERVER_[A-Z0-9_]{1,40}$'),
    CONSTRAINT "db_server_connections_check" CHECK ("max_connections" > 0 AND "reserved_connections" >= 0 AND "reserved_connections" < "max_connections")
);
CREATE UNIQUE INDEX "db_server_name_key" ON "db_server"("name");

-- The stack's one PostgreSQL (and development's): its default max_connections, 15 kept for the superuser's 3, the
-- migrator, the backups and headroom (Q6).
INSERT INTO "db_server" ("name", "region", "max_connections", "reserved_connections", "secret_ref")
VALUES ('local', 'local', 100, 15, 'DB_SERVER_LOCAL');

ALTER TABLE "shard" ADD COLUMN "server_id" UUID,
ADD COLUMN "database" TEXT,
ADD COLUMN "capacity" INTEGER,
ADD COLUMN "pool_size" INTEGER,
ADD COLUMN "status" "ShardStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The bootstrap's pool, as the seed created it (TENANT_POOL_01_DATABASE_URL), registered if it isn't yet.
INSERT INTO "shard" ("name", "kind", "secret_ref", "region")
VALUES ('pool-01', 'POOL', 'TENANT_POOL_01_DATABASE_URL', 'local')
ON CONFLICT ("name") DO NOTHING;

UPDATE "shard" SET
  "server_id" = (SELECT "id" FROM "db_server" WHERE "name" = 'local'),
  "database" = CASE WHEN "name" = 'pool-01' THEN 'univarse_pool_01' ELSE 'univarse_' || replace("name", '-', '_') END,
  "capacity" = CASE WHEN "kind" = 'DEDICATED' THEN 1 ELSE 50 END,
  "pool_size" = CASE WHEN "kind" = 'DEDICATED' THEN 3 ELSE 10 END,
  "status" = CASE WHEN "is_active" THEN 'ACTIVE'::"ShardStatus" ELSE 'RETIRED'::"ShardStatus" END;

ALTER TABLE "shard" ALTER COLUMN "server_id" SET NOT NULL,
ALTER COLUMN "database" SET NOT NULL,
ALTER COLUMN "capacity" SET NOT NULL,
ALTER COLUMN "pool_size" SET NOT NULL;

ALTER TABLE "shard" ADD CONSTRAINT "shard_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "db_server"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "shard_server_id_database_key" ON "shard"("server_id", "database");
-- Q3, Q4 (T37): a pool's database is univarse_pool_NN; a dedicated one is univarse_t_ and 12 lower-case letters or
-- digits, the only names the app will put into a server's URL template. A dedicated shard holds one institution.
ALTER TABLE "shard" ADD CONSTRAINT "shard_database_check" CHECK (
  ("kind" = 'POOL' AND "database" ~ '^univarse_pool_[0-9]{2}$')
  OR ("kind" = 'DEDICATED' AND "database" ~ '^univarse_t_[a-z0-9]{12}$')
);
ALTER TABLE "shard" ADD CONSTRAINT "shard_capacity_check" CHECK ("capacity" > 0 AND ("kind" = 'POOL' OR "capacity" = 1));
ALTER TABLE "shard" ADD CONSTRAINT "shard_pool_size_check" CHECK ("pool_size" BETWEEN 1 AND 50);
-- READY is a dedicated database waiting for its institution; a pool is never "ready".
ALTER TABLE "shard" ADD CONSTRAINT "shard_ready_check" CHECK ("status" <> 'READY' OR "kind" = 'DEDICATED');

CREATE TABLE "migration_run" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "job_id" UUID NOT NULL,
    "commit" TEXT,
    "shard_id" UUID,
    "database" TEXT NOT NULL,
    "status" "MigrationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "applied" INTEGER,
    "last_migration" TEXT,
    "error_code" TEXT,

    CONSTRAINT "migration_run_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "migration_run_commit_check" CHECK ("commit" IS NULL OR "commit" ~ '^[0-9a-f]{7,40}$'),
    CONSTRAINT "migration_run_applied_check" CHECK ("applied" IS NULL OR "applied" >= 0),
    -- Q8: a fixed code, never a message (a database driver's words can carry a host or a value).
    CONSTRAINT "migration_run_error_check" CHECK ("error_code" IS NULL OR "error_code" IN ('unreachable', 'no_credentials', 'migrate_failed', 'rls_failed', 'unexpected')),
    CONSTRAINT "migration_run_end_check" CHECK (
      ("status" = 'RUNNING' AND "finished_at" IS NULL AND "error_code" IS NULL)
      OR ("status" = 'SUCCEEDED' AND "finished_at" IS NOT NULL AND "error_code" IS NULL)
      OR ("status" = 'FAILED' AND "finished_at" IS NOT NULL AND "error_code" IS NOT NULL)
    )
);
CREATE INDEX "migration_run_shard_id_started_at_idx" ON "migration_run"("shard_id", "started_at" DESC);
CREATE INDEX "migration_run_job_id_idx" ON "migration_run"("job_id");
ALTER TABLE "migration_run" ADD CONSTRAINT "migration_run_shard_id_fkey" FOREIGN KEY ("shard_id") REFERENCES "shard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Q8: a run ends once, from RUNNING; what it was (its job, commit, database, start) never changes; no run is deleted.
-- For every role, the migrator included.
CREATE FUNCTION public.guard_migration_run_update() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.commit IS DISTINCT FROM OLD.commit
     OR NEW.shard_id IS DISTINCT FROM OLD.shard_id OR NEW.database IS DISTINCT FROM OLD.database
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'a migration run''s identity can''t change (spec 0039 Q8)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'a migration run ends once (spec 0039 Q8)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER migration_run_guard_update BEFORE UPDATE ON public.migration_run
  FOR EACH ROW EXECUTE FUNCTION public.guard_migration_run_update();
CREATE FUNCTION public.refuse_migration_run_delete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'migration runs are kept (spec 0039 Q8)' USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER migration_run_refuse_delete BEFORE DELETE ON public.migration_run
  FOR EACH ROW EXECUTE FUNCTION public.refuse_migration_run_delete();
CREATE TRIGGER migration_run_refuse_truncate BEFORE TRUNCATE ON public.migration_run
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_migration_run_delete();

-- Grants (Q15, T39). Only the migrator writes servers, shards and runs. The API's and worker's role reads a shard (its
-- status, for the guard and the worker's skip) and, of a server, only its id and the prefix of its URL templates'
-- variable names (Q4: ShardRegistry builds a dedicated database's URL from the environment); nothing of runs. The
-- console reads all three, never a server's secret_ref.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.shard FROM univarse_app_platform;
REVOKE ALL ON public.db_server FROM univarse_app_platform;
GRANT SELECT (id, secret_ref) ON public.db_server TO univarse_app_platform;
REVOKE ALL ON public.migration_run FROM univarse_app_platform;
GRANT SELECT (server_id, database, capacity, pool_size, status, status_changed_at) ON public.shard TO univarse_console;
GRANT SELECT (id, name, region, max_connections, reserved_connections, created_at) ON public.db_server TO univarse_console;
GRANT SELECT ON public.migration_run TO univarse_console;
