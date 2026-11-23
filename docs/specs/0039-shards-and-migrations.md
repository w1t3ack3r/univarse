# Spec 0039: Phase 1's S8, shards and migrations

**Status:** **Draft for the owner's approval** (Q1 to Q16).
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
| T38 | **A half-migrated database serves new code** | One shard's migration fails during a deploy | The shard goes `MAINTENANCE` and its institutions answer 503 until a run succeeds (Q9, Q10); each migration is its own transaction; the run and its fixed error code are recorded and shown |
| T39 | **The platform's runtime roles gain the power to create databases** | A worker compromised, or a convenience grant | Only the owner's host job, as the superuser, creates a database (Q5); a test reads the API's and worker's grants (Q15) |

## Acceptance criteria

1. Every new route declares its permission, the route sweeps cover them, and out of scope is 404.
2. A pooled and a dedicated-database institution are provisioned through the same steps, each on the right shard; a dedicated-cluster one in the integration test with a second PostgreSQL (Q14).
3. Placement never exceeds a pool's capacity; a full set of pools refuses a pooled request; with no ready shard, a dedicated provisioning fails with `no_shard` and resumes after `stack:shards ready`.
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
