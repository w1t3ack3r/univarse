# Spec 0039: Phase 1's S8, shards and migrations

**Status:** **Approved by the owner on 2026-11-23, all as written:** Q1 to Q16, and the `[VERIFY]` numbers (a pool's capacity of 50, pool sizes of 10 and 3, a minimum of 2 ready shards) until load tests replace them. **PR A's decisions Q-A1 to Q-A12 approved on 2026-11-24**, including Q-A3's proposal: new migrations wrap themselves in `BEGIN … COMMIT`, except a `CREATE INDEX CONCURRENTLY` (its own migration). **PR B's decisions Q-B1 to Q-B8 approved on 2026-11-24.** **Q7 changed by the owner on 2026-11-24:** a dedicated institution claims its database when the console creates it, and is refused at once when none is ready (see "PR C: the design").
**Phase:** 1, slice **S8** of [spec 0025](0025-phase-1-control-plane.md), the last slice of Phase 1.
**Builds on:**

- [spec 0036](0036-hybrid-tenancy.md) (approved 2026-11-13): hybrid tenancy, T1 to T14. S8 builds its first slice (T13): shard kinds and capacity, ready dedicated databases, placement by level, migration runs per shard and the console's shard view. Moving an institution between levels is a later slice;
- [spec 0025](0025-phase-1-control-plane.md) S8: "A failed migration on one shard shows there and blocks nothing else";
- [spec 0034](0034-provisioning.md): provisioning's steps, its fixed error codes and its resume;
- [spec 0019](0019-local-production-stack.md) and [spec 0017](0017-pgbouncer-isolation.md): the stack's migrate job, PgBouncer in transaction mode, and the roles;
- [spec 0038](0038-offboarding-and-purge.md): the export and the purge, which must work on every shard;
- [02 §7](../02-architecture.md), [07 §1, §4](../07-data-and-database.md), invariant 1 (tenant data only through `ShardRegistry`).

## Why

Phase 1 ends with every institution's lifecycle in the console. One piece is missing: **where an institution's data lives.** Today there is one pool database, the migrate job knows only that one, and nothing records whether a migration reached it. Spec 0036 fixed the design for more databases (pools, and a database per institution where a contract or a regulator needs one). S8 builds the part that every later phase depends on: shards the platform can count and see, migrations that run and are recorded per shard, and a failure on one shard that stays on that shard.

## What exists today, and what the code showed

- **`shard` has a kind (`POOL`, `DEDICATED`), a `secret_ref`, a region and `is_active`;** `tenant` has `shard_id` (not null) and `tier` (`POOLED`, `DEDICATED`). Nothing uses `DEDICATED` yet.
- **A shard's URL is an environment variable**, named by `secret_ref` (`TENANT_POOL_01_DATABASE_URL`) and read by `ShardRegistry` at first use. A new database therefore needs new env files and a restart of the API and the worker.
- **The PostgreSQL roles are per server, not per database.** `univarse_app` and `univarse_migrator` connect to every UniVarse database with the same password; only the database name changes.
- **The migrate job knows two databases**, by fixed variables: the platform and `pool_01` (`TENANT_POOL_01_MIGRATOR_URL`), both created by its bootstrap (`DATABASES` in `packages/db-ops`). Nothing records a run; a failure fails the whole deploy.
- **The console chooses the shard when it creates an institution** (spec 0034 Q11: the active pool with the fewest institutions), because `tenant.shard_id` is required. Spec 0036 T5 instead has a dedicated institution claim its database in the worker's place step.
- **PgBouncer lists its databases in its rendered config** (`default_pool_size = 10`, `max_client_conn = 200`); PostgreSQL runs with its default `max_connections` (100).
- **The stack has one PostgreSQL server on an 8 GB machine.** A second server is possible in tests (Testcontainers), not on the stack.
- **Platform `MigrationRun`** is named in spec 0025's table list and in 07 §4 ("records `MigrationRun` status"), but doesn't exist.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **Scope (spec 0036 T13):** shard kinds, capacity and servers; ready dedicated databases; placement by level; migration runs per shard, with maintenance for a shard whose migration failed; shard health; the console's shard view. **Not in S8:** moving an institution between levels (T9), restoring one institution from its own dump (T8), and dedicated hosting's price (T12, S10). | Spec 0036's split, approved. |
| Q2 | **Database servers become a platform record:** `db_server` (name, region, `max_connections`, connections reserved for the superuser, the migrator and the backups, and `secret_ref` naming the env variable that holds its URL template, with `{database}` in place of the database name). The stack's one server is `local`. | Spec 0036 T3 and T6 budget connections per server; a server needs a row to hold that budget. |
| Q3 | **A shard gains:** `server_id`, `database` (its name on that server), `capacity` (a pool: 50 by default, `[VERIFY]` by load; a dedicated database: exactly 1), `pool_size` (its PgBouncer server connections: 10 for a pool, 3 for a dedicated database, `[VERIFY]`), and `status`: `READY` (a dedicated database with no institution yet), `ACTIVE`, `MAINTENANCE` (its last migration failed, Q9) or `RETIRED`. `is_active` is replaced by `status` (expand, then contract in a later release). | T3's kind and capacity, T4's ready shards and T7's maintenance, as one state. |
| Q4 | **How the app reaches a shard:** a pool keeps its own `secret_ref`, as today. A dedicated database is reached through its server's URL template with the shard's `database` put in, and only a name matching `univarse_t_[a-z0-9]{12}` is accepted. **A new dedicated database on an existing server then needs no new secret and no restart;** a new server (rare) needs its template in the env files and a deploy. | Ready shards are made while the platform runs (T4). The name pattern and the server's own secret keep a tampered row from reaching any other database, as `secret_ref`'s pattern does today. |
| Q5 | **Ready dedicated databases (T4): `pnpm stack:shards ready [--count <n>]`**, the owner's command on the host. It runs a one-shot job from the migrate image, as the superuser (the only identity that can create databases):<br>• checks the server's connection budget first (Q6) and refuses past it;<br>• creates `univarse_t_<12 random characters>`, owned by the migrator, `CONNECT` revoked from PUBLIC and granted to `univarse_app` only;<br>• applies the tenant migrations and runs `rls:check` on it;<br>• registers the shard `READY` on the platform, with the migration run recorded (Q8);<br>• adds it to PgBouncer's config and reloads PgBouncer (no restart, no dropped connections).<br>The deploy and the console warn when fewer than **2** are ready (`[VERIFY]`). | Provisioning stays seconds long, and the API and worker never hold the right to create a database or a role (T4, acceptance 3). |
| Q6 | **The connection budget (T6):** a server's budget is `max_connections` minus its reserved connections; the sum of its shards' `pool_size` must stay within it. `stack:shards ready` refuses a database the budget can't hold, saying how many connections are left. On the stack: 100 − 15 reserved (the superuser's 3, the migrator, the backups and headroom) = 85, so the platform (10), the relay (5), `pool_01` (10) and about **20 dedicated databases** at 3 each. | A server's backend connections fill before its disk does; the budget is checked before a database exists, not after it fails. |
| Q7 | **Placement by level (T2, T5).** The console's New institution gains a **Level**: Pooled (the default) or Dedicated database, with step-up as today.<br>• **Pooled:** the active pool with the fewest institutions, **under its capacity**. All pools full: the request is refused (409 `provisioning.no_pool_room`, "Every pool is full: add one before provisioning"), since nothing is written yet.<br>• **Dedicated:** the institution is created without a shard; the worker's place step claims a `READY` shard in one statement (`… WHERE status = 'READY' … FOR UPDATE SKIP LOCKED`), sets it `ACTIVE` and the institution's `tier` to `DEDICATED`. No ready shard: the job fails with **`no_shard`**, shown in plain words with what to run, and **Resume** works once one is made.<br>`tenant.shard_id` becomes nullable **only while the institution is `REQUESTED`** (a check constraint). | T5, approved: a dedicated provisioning fails and resumes rather than being refused. Spec 0034's other steps don't change. |
| Q8 | **Migration runs (T7):** a new platform table, `migration_run`: one row per database per migrate job (the platform, or a shard), with the release's commit, its start and end, `status` (`RUNNING`, `SUCCEEDED`, `FAILED`), the migrations applied, the last one's name and a **fixed error code** (never a message, as provisioning's). Written by the migrate job as the migrator; the console reads it. | 07 §4's `MigrationRun`, and what the console shows. |
| Q9 | **The migrate job runs per shard, and one failure stays there:**<br>• the platform first: **a platform failure stops the job and the deploy**, as today;<br>• then every `ACTIVE`, `MAINTENANCE` and `READY` shard in turn, each recorded (Q8), each with its own `rls:check`;<br>• **a shard that fails is set `MAINTENANCE` and the job goes on to the next.** The job then exits **3** ("migrated, except: …"), and the deploy **completes and says so in red**: every other shard's institutions get the new release.<br>• The next deploy, or `pnpm stack:shards migrate <shard>`, retries a shard in maintenance; it returns to `ACTIVE` (or `READY`) once its run succeeds.<br>The job reads the shard list from the platform, so the stack's env files no longer name `pool_01`'s migrator URL. | Spec 0025 S8's criterion: a failure "blocks nothing else". The platform stays all-or-nothing: every shard depends on it. |
| Q10 | **An institution on a shard in maintenance answers 503 `tenant.maintenance`**, with a "scheduled maintenance" page in its name and colours (as the suspended page, spec 0037 Q8), and the worker skips that shard's passes and outbox until it's back. The status is read through the tenant resolver's cache (at most 60 s). | New code meeting an unmigrated database would fail in ways nobody chose; a plain closed sign is better, and only that shard's institutions see it. |
| Q11 | **Shard health:** the worker checks every shard each minute (`SELECT 1` and the latency) and records it on the platform (`shard_health`: last success, latency, a fixed error code). The console reads that; **the console still has no tenant credential** (spec 0025 A2). | T11's "health", without breaking A2. |
| Q12 | **The console's Shards page** (`platform.shard.read`: OWNER and SUPER_ADMIN, T11):<br>• each server: its connection budget and how much is used;<br>• each shard: kind, status, database name, institutions (count and links; "ready" for an unclaimed one), capacity, pool size, its last migration run (applied, failed with its code, when), and its health;<br>• warnings: a pool 80% full, fewer than 2 ready shards, a shard in maintenance, a shard unreachable;<br>• the institution's page shows its level and shard.<br>**No connection string or secret is ever shown,** and there are no actions in S8 (T4: making shards stays the owner's host command). The inbox gets "a shard is in maintenance" and "ready shards are low". | Operators see when a pool is full or ready shards run low, and why an institution is closed for maintenance. |
| Q13 | **The purge and the export on a dedicated shard:** both work as built (row by row, through `ShardRegistry`), since a dedicated database is a shard like any other. After a dedicated institution's purge, its shard is `RETIRED`, and **`pnpm stack:shards retire <shard>`** drops the database, after the next backup has passed and with the shard's name typed twice. T10's "export as a dump" waits for the move slice. | T10's guarantee (the crypto-shred first, the ledger records it) holds today; dropping the database is a clean-up with its own care. |
| Q14 | **Dedicated clusters:** a second server is the same code path (Q2, Q4). It is **proved in an integration test with a second PostgreSQL** (Testcontainers: a server registered, a ready shard on it, an institution provisioned there, migrated and isolated), and **not run on the stack**, whose machine has room for one PostgreSQL. The first real cluster comes with the first institution that needs one. | Spec 0036's acceptance 1, proved where it can be, without pretending the 8 GB machine is two servers. |
| Q15 | **Isolation (T14):** `rls:check` runs on every shard in the migrate job and in CI; the cross-tenant suite runs on a pool **and** a dedicated shard; a test proves a dedicated institution's rows exist only in its own database; a test reads the API's and worker's grants (no `CREATEDB`, no `CREATEROLE`, and on `shard` only the claim's columns for the worker). | The hybrid adds places data can be; each is checked as the pool is. |
| Q16 | **An ADR for the hybrid model** (ADR-038, as spec 0036 asks), and the docs listed below. | A tenancy decision needs its ADR. |

## New threats

| # | Threat | Vector | Controls |
| --- | --- | --- | --- |
| T37 | **A shard row points the app at the wrong database** | A tampered or mistaken `shard` row (another institution's database, the platform's, a database outside UniVarse) | A pool's URL only from its own `secret_ref`; a dedicated database only by a name matching `univarse_t_[a-z0-9]{12}`, on a server whose template comes from the env; `univarse_app` has `CONNECT` on tenant databases only; RLS forced in every database, so even a wrong database shows nothing without the right `tenant_id` context |
| T38 | **A half-migrated database serves new code** | One shard's migration fails during a deploy | The shard goes `MAINTENANCE` and its institutions answer 503 until a run succeeds (Q9, Q10); the run and its fixed error code are recorded and shown. **Prisma does not roll a failed PostgreSQL migration back** (measured in PR A: the statements before the failing one stay), so a shard in maintenance may be half-migrated, and its retry follows the runbook (the cause fixed, then `prisma migrate resolve`) |
| T39 | **The platform's runtime roles gain the power to create databases** | A worker compromised, or a convenience grant | Only the owner's host job, as the superuser, creates a database (Q5); a test reads the API's and worker's grants (Q15) |

## Acceptance criteria

1. Every new route declares its permission, the route sweeps cover them, and out of scope is 404.
2. A pooled and a dedicated-database institution are provisioned through the same steps, each on the right shard; a dedicated-cluster one in the integration test with a second PostgreSQL (Q14).
3. Placement never exceeds a pool's capacity; a full set of pools refuses a pooled request; with no ready shard, a dedicated provisioning ~~fails with `no_shard` and resumes after `stack:shards ready`~~ is refused at once with 409 `provisioning.no_ready_shard` (the owner's change to Q7, 2026-11-24), and succeeds after `stack:shards ready`.
4. `stack:shards ready` refuses past the connection budget, and the API and the worker can't create a database or a role (a test reads their grants).
5. **Migrations run per shard, each recorded. A failure on one shard sets it to maintenance, its institutions answer 503, every other shard is migrated and serves the new release, and the console shows the failure** (spec 0025 S8). A retry returns it to service.
6. A dedicated institution's rows exist only in its own database; `rls:check` and the cross-tenant suite pass on a pool and a dedicated shard.
7. The export and the purge work for a dedicated institution, and `stack:shards retire` drops its database only after a backup, with its name typed twice.
8. The Shards page, the institution page's level, and the maintenance page pass axe at WCAG 2.2 AA on desktop and phone.
9. **Released and deployed; on the stack, the owner makes two ready shards, provisions a dedicated institution onto one, sees both in the Shards page with their migration runs and health, and runs the migration drill** (`pnpm stack:shards drill`: a ready shard made to fail its migration on purpose; it shows in maintenance while every other shard migrates, and a retry returns it to ready).
10. Mutation checks on the guards: the capacity and budget checks, the claim's single statement, the name pattern, the platform-first stop, the per-shard continuation, the maintenance answer and the worker's skip.

## The PRs

| PR | What | Size |
| --- | --- | --- |
| A | Servers and shards (Q2, Q3), `migration_run`, the migrate job per shard with maintenance (Q8, Q9), the 503 and its page, the worker's skip (Q10), ADR-038 | M–L |
| B | Ready shards: `stack:shards ready / migrate / retire / drill`, `ShardRegistry`'s dedicated URLs (Q4), PgBouncer per database with its reload, the connection budget (Q5, Q6) | M |
| C | Placement by level (Q7), shard health (Q11), the dedicated-cluster integration test (Q14), the isolation tests (Q15) | M |
| D | The console's Shards page, the institution's level, the inbox items (Q12) | M |

About **two to two and a half weeks** at S7's pace. **S8 closes Phase 1.**

## The owner's steps

- Approve or change Q1 to Q16, and the `[VERIFY]` numbers (a pool's capacity of 50, pool sizes of 10 and 3, a minimum of 2 ready shards) until load tests replace them.
- After the PRs: the release, the deploy, `pnpm stack:shards ready --count 2`, and criterion 9's check.

## Affected docs

[02 §7](../02-architecture.md) (shards and servers), [03](../03-domain-model.md) (`DbServer`, `Shard`'s new fields and status, `MigrationRun`), [07 §1, §3.5, §4](../07-data-and-database.md) (dedicated databases, PgBouncer per database, the migration runner as built), [08](../08-security.md) (T37 to T39), [10](../10-infrastructure-and-deployment.md) (`stack:shards`, the deploy's exit 3), [12](../12-testing-strategy.md) (the second-server test, isolation per shard), [18](../18-roadmap.md) (S8 and the Phase 1 exit), [19](../19-decision-log.md) (ADR-038), [spec 0036](0036-hybrid-tenancy.md) (what S8 built of it).

## Out of scope

- **Moving an institution between levels** (spec 0036 T9) and **a single institution's dump and restore** (T8): the move slice.
- **New pools from the console:** a new pool is a new database with its own `secret_ref` in the deploy, done by the owner when the Shards page warns. Automating it waits for a second pool being needed.
- **Read replicas, sharding one institution across servers, schema-per-tenant** (spec 0036's out of scope).
- **Dedicated hosting's price** (T12, S10).

## PR A: the design

Written before the code, as the self-review asks; what changes while building is listed under "PR A: what was built".

**The schema** (platform migration `20261124120000_shards`, expand only):
- `db_server`: `name` (unique), `region`, `max_connections`, `reserved_connections`, and `secret_ref`, the **prefix** of the env variables holding its URL templates (`<prefix>_APP_URL`, `<prefix>_MIGRATOR_URL`, each with `{database}` in place of the name). The stack's server is `local`, prefix `DB_SERVER_LOCAL`.
- `shard` gains `server_id`, `database`, `capacity`, `pool_size`, `status` (`READY`, `ACTIVE`, `MAINTENANCE`, `RETIRED`) and `status_changed_at`. Checks:
  - a pool's database is `univarse_pool_NN`; a dedicated one is `univarse_t_` and 12 lower-case letters or digits;
  - a dedicated shard's capacity is 1;
  - a pool size is 1 to 50;
  - one database name per server.
- The existing `pool-01` is backfilled: server `local`, `univarse_pool_01`, capacity 50, pool size 10, `ACTIVE` (or `RETIRED` where `is_active` was false). **`is_active` stays, unused:** a later release drops it (expand → contract).
- `migration_run`: one row per database per migrate job:
  - its job id and the release's commit;
  - the shard, or none for the platform;
  - the database name, its start and end, and `status` (`RUNNING`, `SUCCEEDED`, `FAILED`);
  - how many migrations it applied and the last one's name;
  - a **fixed error code**: `unreachable`, `no_credentials`, `migrate_failed`, `rls_failed` or `unexpected`.
  A trigger lets a run move from `RUNNING` to an end state once and freezes everything else, for every role.
- **Grants:**
  - the console reads `db_server` (not `secret_ref`), the shard's new columns and `migration_run`;
  - the API's and worker's role reads `shard.status`;
  - only the migrator writes `migration_run` and a shard's status.

**The migrate job, per shard:**
1. Bootstrap (unchanged), then the **platform**'s migrations, recorded as a run. **A platform failure stops the job (exit 1) and the deploy, as today.**
2. **Registration:** the bootstrap's pool (`pool-01` on `local`) is registered if missing. The seed did this before, after the migrations, which left a fresh stack with no shard to migrate.
3. **Every `ACTIVE`, `MAINTENANCE` and `READY` shard in turn** (pools first, then by name):
   - its migrator URL: a pool's from `<secret_ref without _DATABASE_URL>_MIGRATOR_URL`, a dedicated one's from its server's template;
   - `prisma migrate deploy` on it, the migrations applied read from `_prisma_migrations` before and after;
   - `rls:check` on it.
   A failure records its code, **sets the shard `MAINTENANCE` and goes on to the next shard.** A success returns a shard in maintenance to `ACTIVE`, or to `READY` if it's a dedicated database with no institution.
4. The seed and the data keys, as today, **skipping any shard in maintenance.**
5. **Exit 0** if everything succeeded; **exit 3** if the platform succeeded and some shard failed, with the shards named.

`--check-only` (the restore rehearsal) checks every shard's migration status and `rls:check`, and changes nothing.

**The deploy:** the migrate job's exit 3 starts the new release anyway, then reports the shards in maintenance in red, and the deploy's result carries them. Exit 1 starts nothing, as today.

**Maintenance on the API and in the web app:**
- **The guard:** the tenant resolver also reads the institution's shard status (inside its 60-second cache). An institution whose shard is in `MAINTENANCE` answers **503 `tenant.maintenance`** with its public name and colours, as a suspended one answers 423. A suspension or an archive takes precedence. The OpenAPI documents the 503 on every institution route.
- **The worker:** `ShardRegistry` refuses a shard that's in `MAINTENANCE` or `RETIRED` (with its own error, its status cached for 60 seconds). The passes that walk institutions leave out those on such a shard, and say once that they did, rather than failing for each one.
- **Readiness:** the API needs the platform and an `ACTIVE` shard if one exists. A stack with every shard in maintenance is still ready: answering 503 is its job then.
- **The web app:** the sign-in page shows a third state beside "temporarily unavailable" and "has closed": "{institution}'s UniVarse is closed for scheduled maintenance. Please try again shortly", in its name and colours.

**ADR-038:** the hybrid tenancy model (spec 0036), with S8's server records and the per-shard runner.

**Tests:**
- **Unit:** the job's order, the platform-first stop, continuing past a failed shard, the exit codes and the status after each outcome; the URL resolution and its refusals.
- **Integration:**
  - a scratch dedicated database, made by the dev migrator (which may create databases in development), registered as a shard and **made to fail its first migration** (a table already in its way);
  - it's recorded `FAILED`, set to maintenance, and its institutions answer 503, while `pool_01` stays served;
  - a retry after removing the obstacle returns it, and the run is `SUCCEEDED` with every migration applied;
  - the `migration_run` trigger, the grants, and the worker's skip.
- **Web E2E:** the maintenance page, with axe, on desktop and phone.
- **Mutation checks:** on the guards listed in criterion 10.

## PR A: what was built

**Built:**
- **The schema** (`20261124120000_shards`):
  - `db_server`, with the stack's `local` registered;
  - the shard's server, database, capacity, pool size and status, with `pool-01` backfilled;
  - `migration_run`, with its trigger and fixed error codes;
  - the grants, and the checks on a dedicated database's name.
- **The URL rules** (`packages/db/src/shard-url.ts`): a pool's own variable, or a server's template with a dedicated database's name as its whole path. Shared by the migrate job and `ShardRegistry`.
- **The migrate job, per shard** (`apps/migrate/src/shards.ts`, `real-shards.ts`, `job.ts`):
  - the platform first, its run recorded;
  - every shard after it, each recorded, each with its own `rls:check`;
  - a failed shard put in maintenance while the next goes on;
  - the seed skipped when its pool is in maintenance;
  - exit 3 naming the shards in maintenance;
  - `--check-only` per shard.
- **The deploy:** exit 3 starts the release and reports the shards in red; any other failure starts nothing, as before.
- **Maintenance:**
  - the guard's 503 `tenant.maintenance` in the institution's name and colours, with `Retry-After: 300`, a suspension or an archive first;
  - `ShardRegistry` refusing a shard in maintenance or retired (its status read at most once a minute);
  - the worker's passes leaving those institutions out (`ON_SERVABLE_SHARD`);
  - readiness healthy while every shard is in maintenance;
  - the web app's "Closed for maintenance" card, with the clock the maintenance notices use.
- **Docs:** ADR-038, 02 §7.1, 03, 07 §4, 08 (T37 to T39), 10 (the deploy and the runbook for a shard in maintenance), 12 and 18.

**Evidence:**
- **Unit:**
  - `shard-url.spec.ts` (6): the URL rules, and every steering attempt refused;
  - the migrate app (24 with `tls.spec.ts`): the order, the platform-first stop, carrying on past a failed shard, each error code, the status after each outcome, the exit codes, `--check-only`;
  - two new deploy tests (exit 3 starts the release; 1, 2, 4 and 137 don't);
  - `health.controller.spec.ts` (3): readiness;
  - the web app's 49, including maintenance read and a busy database's 503 not mistaken for it.
  - The API's unit suite: 458, its static checks included. `tools/stack`: 629, one skipped as before.
- **Integration:**
  - `apps/migrate` `shards.int.spec.ts` (4) on real databases:
    - a scratch dedicated database fails its first migration, is recorded `FAILED` (`migrate_failed`) and goes to maintenance;
    - once resolved, it's retried to `READY` with every migration applied;
    - **a failed migration is measured as not rolled back;**
    - the run's trigger, and the grants.
  - The API's `maintenance.int.spec.ts` (5): the 503 and its `Retry-After`, a suspension's precedence, the registry's refusal and the passes' filter, readiness, back in service.
  - The API's whole integration suite: 670 passed. Its 28 failures on the first run:
    - 25 were the dev ClamAV being stopped, and pass with it running (170 tests in those 5 files);
    - 3 were two test fixtures and a grant pin that predated the new shard columns, now fixed (27 passed in those 3 files).
- **E2E:** `maintenance.e2e.ts` on desktop and phone (4): the card in the institution's name and colour, axe clean, the workspace and reset pages leading there.
- **Mutations: 21 tried, 21 caught:**
  - the URL rules: any `univarse_` name, the placeholder twice, the path unchecked, any variable;
  - the runner: no maintenance on failure, a failure stopping the next shard, a ready shard sent to ACTIVE, `rls:check` ignored, a failed deploy unseen;
  - the job: a platform failure carrying on, seeding a pool in maintenance, the failures unreported;
  - the guard serving maintenance, the registry opening such a shard, maintenance in the passes' filter, a 2-second `Retry-After`;
  - readiness failing when every shard is in maintenance, and passing with no shard;
  - the deploy stopping on exit 3, and going on after any failure;
  - the web app not reading maintenance.

**Decisions made while building (approved by the owner on 2026-11-24):**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **The platform migration registers the `local` server and `pool-01`**, not a step in the job. The seed now only reads the shard, since the app's role no longer writes shards (Q15). | Every environment runs the migrations first: dev, CI, the stack, the release's migrate smoke and a restore. The seed created `pool-01` only after them, which left a fresh stack with nothing for the per-shard runner to migrate. |
| Q-A2 | **The API's and worker's role reads two columns of `db_server`: `id` and `secret_ref`** (a variable-name prefix, not a secret). The design said it read nothing of servers. | `ShardRegistry` needs a dedicated database's server prefix to find its URL template (Q4). Without it readiness failed, which the integration suite caught. |
| Q-A3 | **Prisma doesn't roll a failed PostgreSQL migration back,** measured on a real database: the statements before the failing one stay. T38's "each migration is its own transaction" was wrong and is corrected, and the runbook (10 §4) says what to do. **Proposed, for a later decision:** new migrations wrap themselves in `BEGIN … COMMIT`, which Prisma allows, except a `CREATE INDEX CONCURRENTLY`, which has its own migration already. | What a shard in maintenance may look like has to be stated honestly. Closing its institutions (Q10) is right precisely because it can be half-migrated. |
| Q-A4 | **A retry after a failure needs `prisma migrate resolve`** (`--applied` or `--rolled-back`, once the cause is fixed); otherwise the failed migration's record blocks every later deploy (P3009). PR B's `stack:shards migrate <shard>` takes it as an explicit option, never guessed. | Only a person who has looked can say whether a half-applied migration was finished or undone. |
| Q-A5 | **A maintenance 503 carries `Retry-After: 300`;** every other 503 keeps 2 seconds. | A shard in maintenance stays closed until someone fixes it; a busy database clears in seconds. |
| Q-A6 | **Readiness checks an `ACTIVE` shard when there is one, and stays ready when every shard is in maintenance. With no shard at all, it isn't ready.** | A deploy whose only pool failed must still start, to serve its 503s. A platform with no shard can serve nothing. |
| Q-A7 | **The worker's passes filter institutions in their own platform queries** (`ON_SERVABLE_SHARD`), and `ShardRegistry`'s refusal is the backstop. The key sweep relies on the backstop alone; its per-institution error is already logged. | One shared filter in eight queries, rather than eight new error paths. |
| Q-A8 | **The migrate app gets its own integration tests** (`test:int`, run in CI with the rest). Their scratch databases are made by the development migrator, which may create databases there (never on the stack). Each test removes its own runs with the trigger set aside, as the offboarding tests do for theirs. | The runner's real steps (Prisma, `_prisma_migrations`, the trigger) can only be proved on a real database. |
| Q-A9 | **The seed is skipped when its pool is in maintenance; the data keys step still runs** (platform only). | The seed writes into that pool; the keys don't touch it. |
| Q-A10 | **A platform run is recorded after its migrations,** since they create the table on the first deploy. A failed platform run is recorded only when the table exists. | Recording before would fail on exactly the deploy that adds the table. |
| Q-A11 | **The web app's unavailable shape moves from a `closed` flag to a `kind`** (`suspended`, `closed`, `maintenance`). | Three states don't fit a boolean. |
| Q-A12 | **`shard.is_active` stays, unused;** a later release drops it (expand → contract). | No destructive change in the release that stops using it (invariant 9). |

## PR B: the design

Written before the code, as the self-review asks; what changes while building is listed under "PR B: what was built".

**The stack reaches a dedicated database (Q4):**
- the env files carry the `local` server's two URL templates:
  - `DB_SERVER_LOCAL_APP_URL`, through PgBouncer, for the API, the worker, the keys job and the clock job;
  - `DB_SERVER_LOCAL_MIGRATOR_URL`, direct to PostgreSQL, for the migrate and purge jobs.
  Both verify the server against the stack CA, as every connection does (D7).
- **PgBouncer gets one fallback entry for dedicated databases** (`* = host=postgres port=5432 pool_size=3`), beside its explicit entries for the platform and `pool_01`. Q5 said each new database would be added to PgBouncer's config and PgBouncer reloaded; the fallback does the same with no edit and no reload.
- The fallback reaches only databases a role may connect to. So the bootstrap revokes `CONNECT` on `postgres` and `template1` from PUBLIC; the dedicated databases grant it to `univarse_app` alone.

**`pnpm stack:shards`, the owner's command on the host,** runs a one-shot `shards` job from the migrate image with the migrate job's settings (the superuser only to create and drop a database):
- **`ready [--count <n>]` (Q5):**
  1. checks the server's connection budget (Q6): `max_connections` − reserved − the platform's and relay's pools − every non-retired shard's pool size, which must leave 3 for each new database, or it refuses and says how many are left;
  2. creates `univarse_t_<12 random characters>`, owned by the migrator, with the per-database preparation the bootstrap gives `pool_01` (shared code): `CONNECT` revoked from PUBLIC and granted to `univarse_app`, the schema's owner and its default privileges;
  3. registers it `READY` and migrates it through the per-shard runner (its run recorded; a failure leaves it in maintenance, as for any shard);
  4. connects through PgBouncer as the app's role, to prove the database is reachable the way the API will reach it.
  Each creation and registration is audited on the platform as a host command.
- **`migrate <shard> [--applied <migration> | --rolled-back <migration>]` (Q-A4):** first tells Prisma, if asked, how a failed migration was settled, then runs the per-shard runner on that shard alone. It never guesses which.
- **`retire <shard> --confirm <shard>` (Q13):**
  - only a dedicated shard whose every institution is purged, or that never had one;
  - only once the newest backup set is newer than the last of those purges (checked on the host, where the sets are);
  - it drops the database, sets the shard `RETIRED` and is audited.
- **`drill`:** criterion 9's migration drill, on the stack. It readies a database with its first migration deliberately in the way. It shows the shard in maintenance with its failed run while nothing else is touched. Then it removes the obstacle, settles the failed migration as rolled back, migrates again, and shows the shard `READY`. The shard stays, as a ready one.
- **`list`:** each server's budget and each shard's status, institutions and last run.

**The minimum (Q5):** every migrate job ends with a warning when fewer than 2 dedicated databases are `READY`, and the deploy shows it.

**Tests:**
- **Unit:** the budget arithmetic and its refusals; the arguments of each command; the host command's orchestration and its plain messages (with a fake job); the env files' two templates; PgBouncer's fallback line.
- **Integration (the migrate app, on the development databases, as the migrator, which may create databases there):**
  - `ready` creates, prepares, registers and migrates a database to `READY`, and the app's role can connect to it and nothing else;
  - `migrate` with `--rolled-back` recovers a broken one;
  - `retire` refuses while an institution there isn't purged, and drops it once allowed;
  - the budget refuses past its limit.
- **Mutation checks:** on the guards listed in criterion 10.


## PR B: what was built

**Built:**
- **`pnpm stack:shards`** (`tools/stack/src/shards.ts`): `ready`, `migrate`, `retire`, `drill`, `list`. It runs the `shards` job from the migrate image (`apps/migrate/src/shards-main.ts`, `shard-ops.ts`) and says in plain words what happened; for `retire`, the host adds the newest complete backup set's time.
- **A dedicated database, made ready** (`packages/db-ops`, `createDedicatedDatabase`):
  - created by the superuser, owned by the migrator;
  - `CONNECT` for `univarse_app` alone, the schema and default privileges as `pool_01` has them;
  - registered `READY`, migrated through the per-shard runner, reached through PgBouncer as the app;
  - audited as a host command (`platform.shard.readied`).
- **The connection budget:** `max_connections` − reserved − the platform's three pools (30) − every non-retired shard's pool. Refused below 3, with the count left.
- **`migrate`:** settles a failed migration only as the owner says (`--applied` or `--rolled-back`, audited), then runs that shard.
- **`retire`:** refused for a pool, while an institution there isn't purged, while a purge hasn't finished, or until a backup set is newer than the last purge. It then drops the database, sets the shard `RETIRED` and is audited.
- **`drill`:** a database whose first migration is in the way, recorded as failed and put in maintenance, then settled as rolled back and migrated to `READY`.
- **The minimum:** every migrate job warns when fewer than 2 dedicated databases are ready, with the command that fixes it.
- **The stack:**
  - the `local` server's URL templates in the env files: the app's through PgBouncer for the API, worker, keys and clock jobs; the migrator's, direct, for the migrate and purge jobs;
  - `shards.env` for the new job;
  - PgBouncer's fallback entry for dedicated databases;
  - the bootstrap closing `postgres` and `template1` to PUBLIC.
- **Docs:** 07 §3.5, 08 (T39), 10 (the commands and the runbook's retry), 12 and 18.

**Evidence:**
- **Unit:**
  - the migrate app: 31 (the budget, the arguments, the retire rule, the minimum);
  - `tools/stack`: 639, one skipped as before (the host command's arguments and messages, the env files' templates, `shards.env`, PgBouncer's fallback line, the compose job);
  - the API: 458, its static checks included;
  - contracts: 6.
- **Integration (`apps/migrate`, the development databases):**
  - **10 tests:**
    - `ready` makes a database whose privileges equal `pool_01`'s, PUBLIC with nothing, `rls:check` clean, registered, its run recorded, audited and reached as the app;
    - the budget refuses at exactly 2 connections left, before anything is created;
    - the drill fails one and recovers it;
    - `migrate` refuses an unknown shard and a malformed migration name;
    - `retire` refuses while an institution lives there and refuses a pool, then drops a database and retires it;
    - `list` names every shard.
  - **One more runs in CI only:** `postgres` and `template1` closed to PUBLIC. CI bootstraps a fresh database every run; this machine's database predates the change.
- **Mutations: 18 tried, 18 caught:**
  - the budget: the platform's pools forgotten; ready past it;
  - retire: an unpurged institution, a backup as old as the purge, a pool;
  - migrate: any migration name;
  - the drill not recovering;
  - the minimum: warning at 2;
  - the job's arguments: retire without its name twice, any count;
  - the host: a mismatched confirmation, an unreachable database counted as ready, no backup time passed;
  - the stack's files: no fallback entry, the app's template in `migrate.env`;
  - the database's preparation: no `CONNECT` for the app, PUBLIC keeping `CONNECT`, no default privileges.
  - One survived at first ("ready past the budget"): the test spent the budget entirely, so a guard that only refused a negative budget still passed. It now sets exactly 2 connections left.
- **On the stack:** PgBouncer's fallback entry is proved by `stack:shards ready`'s own reach check, through PgBouncer as the app, in criterion 9. Neither development nor CI runs the stack's PgBouncer.

**Decisions made while building (approved by the owner on 2026-11-24):**

| # | Decision | Why |
| --- | --- | --- |
| Q-B1 | **PgBouncer serves dedicated databases through one fallback entry** (`* = host=postgres port=5432 pool_size=3`), instead of Q5's per-database edit and reload. | A new database needs no edit, no reload and no file kept beside the platform's list. |
| Q-B2 | **The bootstrap revokes `CONNECT` on `postgres` and `template1` from PUBLIC.** | The fallback serves any database name, so it must find nothing a role wasn't granted. |
| Q-B3 | **The budget counts PgBouncer's pools per database and role.** The platform's three roles at 10 each make 30, so the stack has room for **15** dedicated databases, not the "about 20" Q6 estimated. | PgBouncer pools per (database, role); the earlier figure counted the platform once. |
| Q-B4 | **The `shards` job has its own `shards.env`:** the migrate job's settings, plus the app's template through PgBouncer for the reach check. | The migrate job stays direct-only (PB8), which its test enforces. |
| Q-B5 | **`createDedicatedDatabase` repeats the bootstrap's statements for `pool_01`, rather than reshaping the bootstrap's loop.** The integration test compares the two databases' privileges. | The bootstrap runs at every deploy; it stays as it was, and the comparison proves they match. |
| Q-B6 | **`retire` needs a complete backup set newer than the last purge on that database;** a database that never had an institution needs none. | A purge leaves backups as the only copy until they expire; the newest set after it must not be one that still holds the data unencrypted. |
| Q-B7 | **The templates are added now to the clock, keys and purge jobs' files;** the purge's own use of them comes with PR C, when a dedicated institution can exist. | One env-file change per job, made once. |
| Q-B8 | **Three new platform audit actions, written by the host command with no actor:** `platform.shard.readied`, `platform.shard.migration_resolved`, `platform.shard.retired`. The labels test now reads `apps/migrate` too. | Consequential actions are audited (invariant 12), as the purge's host steps are. |

## PR C: the design

Written before the code, as the self-review asks; what changes while building is listed under "PR C: what was built".

**Q7 as the owner changed it (2026-11-24): a dedicated institution claims its database at creation.** Q7 had the institution created without a shard and the worker claiming one later, failing with `no_shard` and resuming. That made `tenant.shard_id` nullable, and 164 places in 31 API files read it as always set. The owner chose instead:
- the console's create request claims a `READY` dedicated database **in its own transaction**, before the institution is written;
- with none ready, it is **refused at once** (409), and nothing is written;
- `tenant.shard_id` stays `NOT NULL`, and the worker's steps don't change.

**The create request (`POST /platform/v1/tenants`):**
- **The body gains `level`:** `POOLED` (the default, so today's callers are unchanged) or `DEDICATED`.
- **Pooled:** the active pool with the fewest institutions, among those **under their capacity** (purged institutions don't count).
  - Every active pool full: **409 `provisioning.no_pool_room`**, "Every pool is full: add one before provisioning".
  - No active pool at all stays 503 `provisioning.unavailable`, as today.
- **Dedicated:** in the create transaction, `SELECT public.claim_ready_shard()`:
  - one statement: `UPDATE shard SET status = 'ACTIVE' … WHERE id = (SELECT id … WHERE kind = 'DEDICATED' AND status = 'READY' ORDER BY status_changed_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`, so two requests never claim the same one;
  - `SECURITY DEFINER`, owned by the migrator, `search_path` fixed; `EXECUTE` for the console's role alone. The console still can't write `shard`;
  - nothing returned: **409 `provisioning.no_ready_shard`**, "No dedicated database is ready: run pnpm stack:shards ready";
  - a later failure in the same transaction (a taken subdomain) rolls the claim back with it.
- **The audit event** (`platform.tenant.provisioning_requested`) gains `level` and `shardId`.

**The database keeps placement honest, for every role (a trigger on `tenant`):** `place_tenant`, `BEFORE INSERT OR UPDATE OF shard_id, tier`. It is `SECURITY DEFINER` (it locks the shard row, which no runtime role may update), owned by the migrator. It:
- locks the shard row, so two placements on one pool are counted one after the other;
- refuses a shard that isn't `ACTIVE` (a ready one must be claimed first; one in maintenance or retired takes no one);
- refuses a pool at its capacity, and a dedicated database that has ever held an institution;
- sets `tier` from the shard's kind (`DEDICATED` or `POOLED`), so a tier can't disagree with where the data is.

The API maps the trigger's refusal on a full pool to the same 409; its own check first gives the plain answer without a failed insert.

**The console's New institution form gains Level:** "Pooled (a shared database)" and "Dedicated database", Pooled selected. Both 409s show in plain words beside the form. Built with impeccable (`--target apps/console`), checked with axe on desktop and phone.

**The purge on a dedicated database (Q13):** its rows step reaches **the institution's own shard** as the migrator, through `shardUrl(…, 'migrator')`: a pool's `…_MIGRATOR_URL`, or a dedicated database's server template, both already in `purge.env` (Q-B7). It no longer assumes `pool_01`. An institution whose shard has no usable URL is refused before anything is deleted.

**Backups:** no change in kind.
- `pg_basebackup` copies the whole server, so a dedicated database is in every set.
- The facts and the rehearsal's checks (row counts, chains, decrypt) go through `ShardRegistry`, which reaches a dedicated database through the keys job's template (PR B).
- An integration test proves `backup-facts` and `verify-chains` cover an institution on a dedicated shard.
- The shred drill's tenant stays on a pool.

**Shard health (Q11):**
- **A platform table, `shard_health`:** one row per shard, upserted with:
  - `checked_at`, `ok` and `latency_ms`;
  - `last_success_at`;
  - a fixed `error_code` (`unreachable`, `timeout`, `no_credentials`, `unexpected`), never a driver's message.
- **A worker pass every minute** (`SHARD_HEALTH_INTERVAL_MS`, 60 s) over every shard not `RETIRED`:
  - `ShardRegistry.probe(shardId)`: `SELECT 1` with a 5 s limit;
  - it **bypasses the maintenance gate**, so a shard in maintenance is still checked;
  - one shard's failure is recorded and the pass goes on.
- **Grants:** the worker's role may `SELECT`, `INSERT` and `UPDATE` the table; the console's role reads it, for PR D's page. The console still has no tenant credential (spec 0025 A2).

**Development:**
- `pnpm db:setup` writes the `local` server's two templates into `.env` for new setups.
- The integration tests derive them from `pool_01`'s URLs, as PR B's did, so existing `.env` files keep working.

**Q14, a second PostgreSQL:**
- An API integration test starts a throwaway **`postgres:18` with `docker run`**: a random local port, a random superuser password held only in memory, removed afterwards.
  - Not the Testcontainers library, which this repository doesn't use; one CLI call doesn't need a new dependency.
  - It runs wherever the integration tests run: CI's runner and this machine both have Docker.
- On it, the test:
  1. creates UniVarse's roles with the bootstrap's own code;
  2. creates a dedicated database with `createDedicatedDatabase`;
  3. applies the tenant migrations and runs `rls:check`.
- It registers server `second` (`DB_SERVER_SECOND`) and the shard `READY` on the development platform, then provisions an institution there through the console's create request and the worker's steps.
- It proves:
  - the institution's rows are on the second server and nowhere on the first;
  - its isolation holds there.
- Its rows are removed at the end.

**Q15, isolation:**
- **A dedicated-shard isolation test** (an institution provisioned on a dedicated database, beside `demo-uni` on the pool):
  - its rows exist only in its own database;
  - each institution's host answers 404 for the other's records;
  - each one's id, opened on the other's shard, reads nothing.
- **The route sweep stays on the seeded pair**, `demo-uni` and `test-poly`, both on `pool-01`. Moving one of them to a dedicated database would change every other test's fixtures; the new test covers the dedicated side.
- **A grants test reads the roles:**
  - the API's, the worker's and the console's roles have no `CREATEDB`, no `CREATEROLE` and no superuser;
  - none may write `shard` or `db_server`;
  - the console may execute `claim_ready_shard` and nothing else that writes a shard.
- **`rls:check`** already runs on every shard in the migrate job (PR A) and on a ready database in PR B's test.

**Tests:**
- **Unit:** pool choice under capacity; the 409s' mapping; the contract's default; the health error codes; the pass going on past a failure.
- **Integration:**
  - the claim: one request claims one database, two never claim the same one (`SKIP LOCKED`), and none ready is refused;
  - the trigger: a full pool, a reused dedicated database and a shard not `ACTIVE`, each for the console's and the app's role, and the tier set;
  - the purge on a dedicated institution;
  - backup facts and chains on a dedicated institution;
  - the health pass, including a shard in maintenance;
  - Q14's second server; Q15's isolation and grants.
- **E2E:** the console provisions a dedicated institution, after the test readies a database. The refusal's words are checked in the form's unit test, since the shared development database may hold ready ones.
- **Mutation checks:** the capacity check (API and trigger), the claim's single statement and `SKIP LOCKED`, the trigger's `ACTIVE` rule and its tier, the purge's shard, the probe bypassing the gate.

## PR C: what was built

**Built:**
- **Placement by level, claimed at creation** (Q7 as the owner changed it):
  - the create request's `level` (`POOLED` by default, or `DEDICATED`);
  - the pool chosen under its capacity (`choosePool` in `packages/domain`), and 409 `provisioning.no_pool_room` when every pool is full;
  - a ready database claimed in the create transaction (`claim_ready_shard()`), and 409 `provisioning.no_ready_shard` when none is ready, with nothing written;
  - the audit event carrying the level and the shard.
- **The database's rule, `tenant_place`:** a shard that isn't `ACTIVE` takes no one; a pool takes up to its capacity; a dedicated database takes one, ever; the tier is the shard's kind. The capture gate checks both functions (definer, owned by the migrator, `search_path` fixed, not PUBLIC) and the trigger (`ENABLE ALWAYS`).
- **The console's New institution form:** "Where its data lives", Pooled or Dedicated database, with both refusals beside the choice and above the form.
- **The purge on a dedicated database:** the rows step reaches the institution's own shard as the migrator (`migratorShards`, through `shardUrl`), and refuses one with no URL (`no_shard_url`) before deleting anything.
- **Backups with a shard in maintenance:** the facts and the rehearsal's tenant checks pass over its institutions and name them (`skipped`).
- **Shard health:** `shard_health`, the worker's pass every minute (`ShardHealthPass`, `ShardRegistry.probe`), its grants.
- **Development:**
  - `pnpm db:setup` writes the `local` server's two templates;
  - its PgBouncer config gains the fallback entry the stack has;
  - `pnpm db:seed` gives development's pool room for its tests' institutions.
- **Docs:** 03, 07 §3.5, 08 (T37, T39), 10 (the runbook), 12 §3, 18.

**Evidence:**
- **Unit:** every package passes (API 462, the health pass's 4 among them; domain 161, the pool choice's 5 among them; `tools/stack` 639, one skipped as before; the migrate app 31; PgBouncer's config 23, its fallback entry among them).
- **Integration, on the development databases:**
  - `placement.int.spec.ts` 17, `shard-health.int.spec.ts` 5, `dedicated.int.spec.ts` 6, `second-server.int.spec.ts` 4, and the purge's suite 9 with its two dedicated tests;
  - `packages/db` 55, `packages/crypto` 19, the migrate app 10 (one CI-only, as before);
  - the whole API suite passes except the file scanner's tests, run without ClamAV on this machine (0.7 GB free); CI runs them with it.
- **E2E:** the console's level and refusal (desktop and phone, axe), J1 unchanged, and the web app's maintenance page (4).
- **Mutations: 17 tried, 17 caught:**
  - the trigger: a shard not `ACTIVE` taking one, a pool past capacity, a dedicated database reused once purged, the tier not set, the migrator's exemption widened to everyone;
  - the claim: without `SKIP LOCKED`, any dedicated shard ready or not;
  - the pool choice: a full pool chosen, purged institutions counted, the 409 answered as something else, the claim never asked;
  - health: the probe through the maintenance gate, retired shards checked, a failure forgetting the last success, the pass stopping at a failure;
  - the purge on the pool whatever the shard; the backups reading a shard in maintenance.
- **Fixtures:** five suites picked "the first active shard" (four by the retired `is_active`); they now name `pool-01`, since a dedicated database can be active too.

**Decisions made while building (for the owner's approval):**

| # | Decision | Why |
| --- | --- | --- |
| Q-C1 | **A dedicated institution claims its database when the console creates it, and is refused at once when none is ready** (409 `provisioning.no_ready_shard`), instead of Q7's create-then-fail-and-resume. **The owner chose this on 2026-11-24**, before the design; it is recorded here with the rest. | `tenant.shard_id` stays `NOT NULL`: 164 places in 31 API files read it as always set. The worker's steps don't change, and nothing waits half-made for a database. |
| Q-C2 | **The placement rule binds the runtime roles** (console, app, relay); **the migrator, the schema's owner, is exempt from its refusals.** The tier follows the shard for every login. | Three test suites keep several scratch institutions on one retired shard, as the migrator. The migrator could drop the trigger anyway, so the exemption gives away nothing the threat model guards. |
| Q-C3 | **Development's and CI's pool takes 10 000 institutions** (`pnpm db:seed` sets it before seeding); the stack keeps the approved 50. | Development's database already holds 285 test institutions on `pool-01`; at 50, every test that makes one would be refused. |
| Q-C4 | **The backup's facts and the rehearsal's tenant checks pass over institutions on a shard in maintenance or retired, and name them** (`skipped`). | Found while building: since PR A's gate, one shard in maintenance would have failed every backup and rehearsal, against Q9's "a failure blocks nothing else". The base backup still copies every database. |
| Q-C5 | **Development's and CI's PgBouncer gets the stack's fallback entry** (`* = host=… port=…`, at the profile's pool size). | CI runs the API's integration suite through PgBouncer too, and the dedicated databases' tests reach them through the app's template there. |
| Q-C6 | **The second PostgreSQL (Q14) is started by the test with `docker run`**, not the Testcontainers library Q14 named. | The repository doesn't use the library; one CLI call needs no new dependency. Docker is on CI's runner and on this machine. |
| Q-C7 | **The route sweep stays on the seeded pair**; the dedicated side has its own isolation tests: rows only in its database, each host signing in only its own people, each id reading nothing on the other's shard. | Moving `test-poly` to a dedicated database would change every other suite's fixtures. Q15's "the cross-tenant suite on a dedicated shard" is met by these tests, not by the sweep. |
| Q-C8 | **The console's E2E checks the level and the refusal against the real API** (with the ready databases held locked); **a dedicated provisioning end to end is the API's integration test, and criterion 9 in the browser on the stack.** | Making a ready database needs the database tools the console's E2E doesn't carry. |
| Q-C9 | **`apps/api` gains three dev dependencies** (`@univarse/db-ops`, `pg`, `@types/pg`), already in the lockfile, so nothing new is downloaded. | The tests make real dedicated databases with db-ops' own code. |
| Q-C10 | **Shard health's codes are `unreachable`, `timeout`, `no_credentials` and `unexpected`; a check waits 5 s; a failure keeps the last success.** A retired shard isn't checked. | The console shows how long a shard has been down, never a driver's words. |
| Q-C11 | **A pool that goes into maintenance between the check and the insert answers 503 `provisioning.unavailable`**, as no active pool does today. | Rare, and "every pool is full" would be the wrong words. |
