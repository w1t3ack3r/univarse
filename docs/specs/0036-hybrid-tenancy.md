# Spec 0036: Hybrid tenancy: shared pools by default, a dedicated database or cluster where it's needed

**Status:** **Approved by the owner on 2026-11-13, all as written:** T1 to T14. Built later, with S8 and after S7 (T13); nothing here changes S5 as built.
**Phase:** design now; built in Phase 1 S8 and a slice after S7.
**Builds on:**

- [02 §7](../02-architecture.md) and [07](../07-data-and-database.md): the platform database, pool shards, RLS on every tenant table, `ShardRegistry` as the only way to tenant data (invariant 1);
- [spec 0034](0034-provisioning.md): provisioning's "place" step (Q11: the active pool with the fewest institutions), the `DEDICATED` tier left for later, data keys per institution;
- [spec 0025](0025-phase-1-control-plane.md) S7 (the full institution export) and S8 (shards and migration runs);
- research on managed PostgreSQL (2026-11-12, for reference only: UniVarse stays fully local under [ADR-030](../19-decision-log.md)): a managed server's backend connections are few (DigitalOcean's 4 GiB server, for one, has 97), and a provider's built-in pooler may cap the number of pools (21 per cluster there);
- [BP-1](../billing-model.md): the per-student rate and tiers; [ADR-023](../19-decision-log.md): an in-country dedicated deployment with its own Vault.

## Why

Every institution today shares a pool database with the others, separated by `tenant_id` and row-level security. That's right for most of them, and cheap. Some will want, or need, more: a large federal university with its own procurement rules, an institution whose contract asks for its own database, or one that must keep its data in Nigeria. One database per institution for everyone would cost a server's connections for each, and multiply every migration; one pool for everyone can't satisfy them. A hybrid gives each institution the level it needs, with one codebase and one set of rules.

## What exists today, and what the code showed

- **Every tenant already points at a shard** (`tenant.shard_id`), and every tenant-side read and write goes through `ShardRegistry.tx(shard, tenant)`. A dedicated database is a shard with one institution in it: no query changes.
- **`TenantTier` (`POOLED`, `DEDICATED`) and `ShardKind` (`POOL`, `DEDICATED`) are already in the schema;** nothing uses `DEDICATED` yet.
- **A shard's connection string is a secret reference** (`shard.secret_ref` names the variable), never stored in the database. A new shard means a new secret in the deploy, not a row with a password.
- **Data keys belong to the institution, not the database** (spec 0006), so moving an institution between databases keeps its key and its encrypted values.
- **Migrations run once per tenant database already** (the migrate job runs the tenant migrations against pool-01); S8 turns that into a recorded run per shard.

## The three levels

| Level | Where its data lives | For whom |
| --- | --- | --- |
| **Pooled** (default) | A pool database shared with other institutions | Most institutions |
| **Dedicated database** | A database of its own, on a server holding other institutions' dedicated databases | An institution that pays for it, or whose contract or regulator needs it |
| **Dedicated cluster** | A PostgreSQL server of its own, possibly in another region or in Nigeria, with its own Vault if required (ADR-023) | The largest institutions, or data kept in Nigeria |

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| T1 | **Three levels, one model:** each is a shard; the app never asks which level an institution is at. RLS stays forced on every tenant table at every level. | One code path and one set of tests; RLS is the second wall even where a database is the first. |
| T2 | **Pooled is the default; the level is chosen when an institution is created** (OWNER or SUPER_ADMIN, step-up, audited), and changed only by a move (T9). | Most institutions never need more, and a level change is an operation with its own care. |
| T3 | **A shard has a kind and a capacity:** `POOL` (a target number of institutions, `[VERIFY]` by load, starting at 50), `DEDICATED` (exactly one institution), and the server it lives on. Placement never exceeds a pool's capacity; a full pool takes no new institution. | Placement needs a limit to stop at, and an operator needs to see when a new pool is due. |
| T4 | **Dedicated databases are made ready in advance, never on the fly.** An operator job (`stack:shards ready`, later a console action for OWNER) creates empty databases on a dedicated server, applies the tenant migrations, sets the roles and RLS, and registers each as a `DEDICATED` shard with no institution. It keeps a minimum ready (`[VERIFY]`: 2 per server), and warns below it. | Provisioning stays fast (seconds), and the worker never holds the power to create databases or roles: it only claims one that exists. |
| T5 | **Provisioning's "place" step, by level:** pooled, as built (the active pool with the fewest institutions, under capacity); dedicated database, claims a ready shard atomically (one `UPDATE … WHERE tenant IS NULL`); dedicated cluster, an operator prepares the server first, then provisioning places the institution on it. No ready shard: the job fails with a fixed code (`no_shard`), and resumes once one is made. | Spec 0034's steps don't change beyond the first; a failure is explained and resumable, as every other. |
| T6 | **Connections are budgeted per server.** Our own PgBouncer (as locally today; a provider's built-in pooler may cap the number of pools) pools each database separately, with a small pool per dedicated database (`[VERIFY]`: 3 to 5 server connections) and larger ones for pools. A server takes a dedicated database only if its backend connections allow it. | A server's backend connections, not its disk, fill first: a small server has about a hundred. |
| T7 | **Migrations run per shard** (S8): each shard records its own run and status; a failure on one blocks nothing else, and that shard's institutions see a maintenance notice until it's fixed. Ready shards are migrated with the rest. | A hundred dedicated databases mean a hundred migration runs; each must be visible and independent. |
| T8 | **Backups:** a managed server is backed up whole (its PITR), with the sealed off-site sets of spec 0020 per server. A dedicated database can also be dumped and restored alone; the single-institution restore rehearsal uses a dedicated one. | Restoring one institution is the dedicated level's practical benefit; it should be proved. |
| T9 | **Moving an institution between levels** (both ways): a ready shard claimed; the institution's rows copied table by table in a short maintenance window (S7's export, written to a database instead of an archive); row counts and a checksum compared; the shard pointer switched in one audited transaction; the old rows removed only after the next backup has passed. Its address, accounts, sessions and data key don't change. Two people approve it (S6's approvals). | A move touches every row an institution has; it needs the same care as a purge. |
| T10 | **Deleting and exporting at the dedicated level** use the database: an export is a dump of it (still encrypted per field, as S7 requires), and a purge destroys its key (spec 0020's protocol) and then drops the database. The shred ledger records it as for any other. | Simpler and more complete than row-by-row, and the crypto-shred still guarantees a restored backup can't bring it back. |
| T11 | **The console shows each shard:** its kind, server, institutions (or "ready"), capacity, connection budget, migration status and health. OWNER and SUPER_ADMIN see it; creating ready shards and starting a move need step-up. No connection string is ever shown. | Operators need to see when a pool is full or ready shards are low, without reading a secret. |
| T12 | **Pricing is a billing decision:** dedicated hosting becomes a price-book line (per semester, by size) under S10; this spec only makes it possible. | BP-1 owns prices. |
| T13 | **Built in two slices:** **S8** (as planned, extended): shard kinds and capacity, ready shards, placement by level, migration runs per shard, the console's shard view. **A slice after S7:** moving an institution between levels. Until the first institution needs dedicated hosting, everyone stays pooled. | No work before a customer needs it, but the design is fixed now so S5 to S8 don't close it off. |
| T14 | **Isolation is tested at every level:** the cross-tenant tests and `rls:check` run against every shard, ready ones included; a test proves a dedicated institution's rows exist in its own database only, and that a move leaves nothing behind in the pool after its clean-up. | The hybrid adds places data can be; each must be checked like the pool is. |

## Acceptance criteria (for S8 and the move slice)

1. A pooled, a dedicated-database and a dedicated-cluster institution are provisioned, each on the right shard, through the same eight steps.
2. Placement never exceeds a pool's capacity; with no ready shard, a dedicated provisioning fails with `no_shard` and resumes after one is made.
3. The worker holds no right to create a database or role (a test reads its grants).
4. Migrations run per shard, each recorded; a failure on one shard leaves the others running and is visible in the console.
5. The connection budget is enforced: a server refuses a dedicated database it has no connections for.
6. A move, both ways, keeps the institution's rows, keys, accounts and sessions; the counts and checksum match; the old rows are gone after clean-up; two approvals were needed.
7. A dedicated institution can be restored alone from its dump, and purged (key destroyed, database dropped) with the ledger recording it.
8. `rls:check` and the cross-tenant tests pass on every shard.

## The owner's steps

- Approve or change T1 to T14.
- Later, under S10: the price of dedicated hosting.
- When the first institution asks for it: approve its level.

## Affected docs

In the implementation PRs: [02 §7](../02-architecture.md), [03](../03-domain-model.md) (`Shard`'s kind, capacity and server), [07](../07-data-and-database.md) (ready shards, connection budgets), [10](../10-infrastructure-and-deployment.md), [12](../12-testing-strategy.md), [18](../18-roadmap.md) (S8, and the move slice), [19](../19-decision-log.md) (an ADR for the hybrid model), [spec 0025](0025-phase-1-control-plane.md) (S8's row).

## Out of scope

Schema-per-tenant (a third model, rejected: it gives a pool's connection limits with a database's migration cost), sharding one institution across servers, read replicas per institution, and the price of dedicated hosting (S10).
