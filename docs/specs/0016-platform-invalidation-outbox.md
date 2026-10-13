# Spec 0016: Platform invalidation outbox — database triggers capture every change to the cached platform tables

**Status:** **Draft for review (2026-10-13).** Design only; nothing is implemented. It needs the owner's decisions D1–D6 and acceptance of [ADR-031](../19-decision-log.md) (proposed with this spec).
**Phase:** 0. A follow-up to [spec 0015](0015-cache-isolation.md), which is complete for today's caches. It does not reopen spec 0015 and is not a Phase 0 exit criterion by itself; it closes the limits spec 0015 recorded.
**Builds on:**

- [spec 0015](0015-cache-isolation.md): the `InvalidationBus`, its channels, the products subscriber and the generation guard (CI3);
- [spec 0002](0002-audit-and-outbox.md) Part B: the tenant transactional outbox and its relay, whose claim pattern this adapts;
- [07](../07-data-and-database.md): migrations, grants and the current rule on triggers;
- [ADR-015](../19-decision-log.md): PgBouncer in transaction pooling (next on the roadmap).

## Why

Spec 0015 makes the API publish an invalidation after it commits a change to `tenant`, `tenant_domain` or `tenant_product`. A static guard (CI10) checks that every writer in the API's TypeScript does so. The owner accepted the guard, and its record keeps three limits open:

- **A type that lies:** a SQL fragment cast through `as unknown as string` reaches a raw template unseen.
- **Behaviour inside the database:** stored functions, and SQL assembled at run time (`EXECUTE 'UPDATE ' || 'tenant'`, `format()`).
- **Writers outside the API's TypeScript:** the seed, a migration, an operator's `psql`, a future service.

Each of these changes a row without a publish, so other instances serve the old value until their cache entry expires (30 s for products and the tenant resolver).

**The fix is to capture the change where it happens.** A trigger on each of the three tables writes an invalidation event in the **same transaction** as the change. A relay in the worker publishes committed events to the bus. Any writer is covered, whatever its language. A rolled-back change leaves no event, and an event is visible only after its change commits, so publishing after commit holds by construction.

**Where the tables live.** All three are in the **platform** database, outside tenant RLS. The tenant outbox relay ([spec 0002](0002-audit-and-outbox.md) B3–B10) claims per tenant, per shard, under that tenant's RLS context, so it can't be reused as it is. This spec adds a platform relay that keeps its claim pattern (`FOR UPDATE SKIP LOCKED`, outcome recorded in the claiming transaction).

## Decisions for the owner

Each has a recommendation. Nothing is built until they are decided.

- **D1, TRUNCATE.** A row trigger doesn't fire on `TRUNCATE`, and a statement trigger can't name the tenants.
  - **Recommended:** a `BEFORE TRUNCATE` trigger on each table that **raises**, so TRUNCATE is refused for every role. Nothing truncates these tables today (checked: no code, test or tool). The app role already lacks TRUNCATE; this extends the refusal to the owner role, short of disabling the trigger.
  - **Alternative:** emit an "every tenant" event, which needs a second message shape on the bus (spec 0015 CI8 allows only `{tenantId}`).
- **D2, the in-code publishes.** `ProductService.invalidate()` already publishes directly after commit.
  - **Recommended:** keep it as the fast path. The trigger outbox is the guarantee. A change then reaches subscribers twice, which is harmless (an extra eviction).
  - **Alternative:** remove it, so the relay is the only path. That adds the relay's polling delay to every toggle.
- **D3, the CI10 static guard, once this lands.**
  - **Recommended:** retire its bindings in a follow-up PR after IO1–IO14 are green in CI. Keep CI9 (the one path to full-tenant destruction), which the trigger doesn't replace. The guard's maintenance cost is high, and the trigger is the enforcement.
  - **Alternative:** keep it as an early warning.
- **D4, how the relay wakes.**
  - **Recommended:** **poll** every 250 ms against a partial index. That is a few milliseconds of idle cost, well within the 2 s target, and it works through PgBouncer's transaction pooling.
  - **Alternative:** `LISTEN`/`NOTIFY` as a wake-up hint on a direct, non-pooled connection. It is faster, but needs a connection that bypasses PgBouncer (which doesn't support `LISTEN` in transaction mode), and polling would still be needed as the fallback.
- **D5, the resolver's negative entries.** The tenant resolver caches by host, and caches **unknown** hosts too (flood protection). A new hostname, a newly verified domain, or a domain moved between tenants can be cached as unknown. A `{tenantId}` message can't name those entries.
  - **Recommended:** on any `uv:tenants:invalidate` message, evict that tenant's entries **and every negative entry**. Only platform writes trigger these messages, so an attacker can't use them to flush the negative cache.
  - **Alternative:** carry hostnames in the message, which changes spec 0015 CI8's message shape.
- **D6, undelivered events.** With Valkey down, events can't be published.
  - **Recommended:** retry with a short capped backoff until the event is older than the longest cache TTL on its channel. Then mark it `EXPIRED` and log a count, because by then every cache entry loaded before the change has expired anyway (the TTL bound of spec 0015 CI2).
  - **Alternative:** retry forever.

## Acceptance criteria

All in integration tests against real Postgres and Valkey, with two API instances and the worker, unless stated.

| ID   | Criterion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IO1  | _Transactional capture._ An `INSERT`, `UPDATE` or `DELETE` on `tenant`, `tenant_domain` or `tenant_product` writes the expected events **in the same transaction**, before commit:<br>• `tenant` and `tenant_domain` → `uv:tenants:invalidate`;<br>• `tenant_product` → `uv:products:invalidate`;<br>• inside that transaction the event rows exist, and from another connection they don't, until it commits.                                                                                                                                                                         |
| IO2  | _Rollback leaves nothing._ A rolled-back transaction, and a rolled-back **savepoint** inside a transaction that commits, leave **no** event for the rolled-back change, and nothing is published for it.                                                                                                                                                                                                                                                                                                                                                                               |
| IO3  | _Any writer is covered._ Changes made **without** the API's code each reach both API instances' caches within **2 s** of commit:<br>• a plain `pg` connection as the app role;<br>• the same as the migrator role;<br>• a stored function doing the update;<br>• `EXECUTE` of SQL built at run time;<br>• the "type that lies" case from spec 0015's record.                                                                                                                                                                                                                           |
| IO4  | _Ownership changes invalidate both tenants._ An `UPDATE` that changes the tenant a row belongs to emits an event for the **old and the new** tenant id, and both tenants' cache entries are evicted on every instance. That covers:<br>• `tenant_product.tenant_id` A → B;<br>• `tenant_domain.tenant_id` A → B;<br>• `tenant.id` changed, including the rows it cascades to.<br>For any `UPDATE` where the id doesn't change, the event names that one tenant once. An `UPDATE` that changes no column emits nothing.                                                                 |
| IO5  | _Cascades are captured._ Deleting a tenant emits events for the tenant and for each `tenant_domain` and `tenant_product` row its cascade deletes (row triggers fire on cascaded actions). The test tenant has no data keys, because `tenant_data_key` restricts deletion (`ON DELETE RESTRICT`).                                                                                                                                                                                                                                                                                       |
| IO6  | _TRUNCATE (per D1)._ With the recommendation: `TRUNCATE` on each table fails, for the app role and the migrator role, and no row is removed.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| IO7  | _The relay publishes only committed events, after commit._ An event becomes claimable only once its transaction commits. The relay claims with `FOR UPDATE SKIP LOCKED` in a platform transaction, publishes, and records the outcome **in that same transaction**.                                                                                                                                                                                                                                                                                                                    |
| IO8  | _Relay crash before publishing._ A relay whose connection is killed after claiming and before publishing releases its locks. Another relay (or the same one, restarted) claims and publishes the event within the bound. Nothing is lost.                                                                                                                                                                                                                                                                                                                                              |
| IO9  | _Relay crash after publishing (duplicate delivery)._ A relay killed **after** a publish and before its commit leaves the event unpublished in the table. It is claimed and published **again**. Subscribers converge: the second message is an extra eviction, with no error and no wrong value. Delivery is therefore **at least once** to Valkey. Messages carry no event id, and consumers need none, because eviction is idempotent.                                                                                                                                               |
| IO10 | _Concurrent relays._ With two relays running, each event is claimed by exactly one relay per attempt (`SKIP LOCKED`), and every event is published. Two relays may publish the same tenant from different events, which is harmless.                                                                                                                                                                                                                                                                                                                                                   |
| IO11 | _Valkey down (per D6)._ With Valkey unreachable:<br>• changes still commit;<br>• the relay's attempt is bounded (spec 0015's 5 s), and its transaction ends within a bound;<br>• events are retried with backoff, and published once Valkey returns;<br>• an event older than the channel's longest cache TTL is marked `EXPIRED` and counted in a warning;<br>• no instance serves a pre-change value beyond that TTL.                                                                                                                                                                |
| IO12 | _Isolation of the messages and the evictions._<br>• Messages still carry **only** a tenant id (spec 0015 CI8).<br>• A change to tenant A evicts A's entries, and B's positive entries survive on every instance.<br>• With D5's recommendation, negative resolver entries are evicted on any tenants message, and a newly added or verified hostname resolves within 2 s.<br>• The resolver gains spec 0015's per-generation guard (CI3): a lookup that began before an eviction doesn't cache its result.                                                                             |
| IO13 | _The triggers can't silently go missing._<br>• The triggers are created `ENABLE ALWAYS`, so `session_replication_role = replica` doesn't skip them.<br>• A gate (in `pnpm rls:check`, which already runs in CI) fails if any of the expected triggers is missing or not `ENABLE ALWAYS`.<br>• The trigger function is `SECURITY DEFINER`, owned by the migrator, with a fixed `search_path`.                                                                                                                                                                                           |
| IO14 | _Least privilege on the outbox table._ The platform app role can't `INSERT` into `cache_invalidation_event` (only the trigger function writes it), can't `TRUNCATE` it, and can `UPDATE` only the relay's bookkeeping columns. The default privileges that grant full DML on new platform tables are explicitly revoked for this table. Tests assert each refusal.                                                                                                                                                                                                                     |
| IO15 | _Bounded growth._ Published and expired events are deleted in batches after **24 h** by the relay. A burst of N changes to one tenant is coalesced into one publish per batch.                                                                                                                                                                                                                                                                                                                                                                                                         |
| IO16 | _Evidence._ Every IO ID appears in a test name. The mutation checks are recorded with their failing tests. They cover:<br>• a missing trigger on each table;<br>• an `UPDATE` that emits only the new tenant id;<br>• no `WHEN` filter (a no-op update emits);<br>• the relay marking an event published before publishing;<br>• publishing without the claiming lock;<br>• expiry too early;<br>• no negative-entry eviction;<br>• no resolver generation check;<br>• `SECURITY INVOKER` (the app role then needs INSERT, and IO14 fails);<br>• `ENABLE` in place of `ENABLE ALWAYS`. |

## Design

**The event table** (platform database, expand-only migration):

```sql
CREATE TABLE cache_invalidation_event (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  channel          text NOT NULL CHECK (channel IN ('uv:tenants:invalidate', 'uv:products:invalidate')),
  tenant_id        uuid NOT NULL,          -- no FK: the tenant may have just been deleted
  source           text NOT NULL,          -- e.g. 'tenant_product:UPDATE'; never row values
  created_at       timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'EXPIRED')),
  settled_at       timestamptz,
  last_error       text                    -- an error class only, as in spec 0002 B9
);
CREATE INDEX cache_invalidation_event_due ON cache_invalidation_event (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX cache_invalidation_event_settled ON cache_invalidation_event (settled_at) WHERE status <> 'PENDING';
```

It holds only channel names and tenant ids: no personal data, no values (invariant 8).

**The trigger function**, one for all three tables, with the channel as its argument:

- `AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW`, created `ENABLE ALWAYS`.
- **Which tenant ids:** `INSERT` → the new row's; `DELETE` → the old row's; `UPDATE` → the old row's, plus the new row's when it differs (IO4).
  - The tenant id is `tenant.id` for `tenant`, and `tenant_id` for the other two.
- **No-op updates:** `UPDATE` triggers carry `WHEN (OLD IS DISTINCT FROM NEW)`, so an update that changes nothing emits nothing.
- **Privileges:** `SECURITY DEFINER`, owned by `univarse_migrator`, `SET search_path = pg_catalog, public`. It inserts only into `cache_invalidation_event`.
- **TRUNCATE (D1):** a `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger that raises `feature_not_supported`, also `ENABLE ALWAYS`.
- **What this is not:** business logic. The trigger records _that_ a row changed and which tenant it belongs to, nothing about what changed. ADR-031 amends docs/07's trigger rule to allow exactly this.

**The relay, `PlatformInvalidationRelay`,** runs in the worker, beside the tenant outbox worker:

1. **Claim:** in a platform transaction, select up to 200 `PENDING` events with `next_attempt_at <= now()`, `ORDER BY next_attempt_at, id`, `FOR UPDATE SKIP LOCKED` (IO7, IO10).
2. **Expire (D6):** events older than the channel's longest cache TTL (`TENANT_CACHE_TTL_MS`, today 30 s, for both channels) become `EXPIRED` without a publish, and are counted in a warning.
3. **Coalesce:** publish each distinct `(channel, tenant_id)` once (IO15).
4. **Publish** through `InvalidationBus.publish`, which is bounded (5 s) and never throws.
   - When a publish succeeds, every event of that pair becomes `PUBLISHED`.
   - **On the first failure, stop.** Valkey is unavailable, so every remaining event gets `attempts + 1`, a backoff (250 ms doubling, capped at 5 s, with jitter), and its error class. That keeps one batch's transaction under about 6 s.
5. **Commit.** A crash anywhere before this point leaves every claimed event `PENDING`: before the publish, IO8; after it, IO9.
6. **Housekeeping:** at most once a minute, delete settled events older than 24 h, in batches of 1 000 (IO15).

The loop polls every 250 ms when idle (D4) and immediately after a full batch. Passes never overlap.

**Consumers:**

- **Products:** unchanged. `ProductService` already subscribes in the API and the worker, with its generation guard.
- **The tenant resolver** (API) gains a subscriber on `uv:tenants:invalidate`, which today has none:
  - It evicts entries whose tenant is the message's tenant, and, per D5, every negative entry.
  - It gains the per-generation guard of spec 0015 CI3.
  - Its whole-cache `invalidate()` stays for lifecycle code.

**Ordering and timing:**

- **Publish follows commit by construction:** the relay can only see an event once its change has committed. An eviction can therefore never arrive before the change it announces.
- **The order between events doesn't matter,** because every message means the same thing: evict this tenant.
- **Within the 2 s target:** one poll interval plus a publish.

**Grants (IO14).** Platform default privileges give the app role `SELECT, INSERT, UPDATE, DELETE` on new tables, so the migration revokes explicitly. It leaves the app role:

- `SELECT` and `DELETE`;
- `UPDATE (attempts, next_attempt_at, status, settled_at, last_error)`.

**The integrity gate (IO13).** `pnpm rls:check` gains a platform check. It reads `pg_trigger` and fails unless each of the six expected triggers (one row trigger and one TRUNCATE trigger on each of the three tables) exists with `tgenabled = 'A'`.

**What stays open, stated plainly:**

- **The owner role can still bypass capture.** `univarse_migrator`, or a superuser, can `ALTER TABLE … DISABLE TRIGGER` or drop the function. Nothing at the database level stops the owner role. The IO13 gate detects it the next time it runs; it does not prevent it.
- **A subscriber that is down when a message is sent** still relies on the cache TTL, as in spec 0015 CI2: pub/sub doesn't queue for absent subscribers.
- **The keyring's forget** (`uv:keys:forget`) stays on its in-code path. Key destruction already publishes after commit with an honest report (spec 0015 CI5–CI9), and `tenant_data_key` is not in scope here.

## Affected docs (in the implementation PR)

- **[07](../07-data-and-database.md):** the trigger rule (amended per ADR-031), the new table, its index and grants, and the integrity gate.
- **[02](../02-architecture.md) §7:** the platform invalidation path beside the tenant outbox.
- **[spec 0015](0015-cache-isolation.md):** link this spec from its "carried forward" record. Per D3, CI10's bindings are retired later.
- **[12](../12-testing-strategy.md) §3 layer 5:** the evidence line.
- **[18](../18-roadmap.md):** the tracked gap, closed once accepted and merged.
- **[19](../19-decision-log.md):** ADR-031 to Accepted.

## Out of scope

- The keyring forget path and `tenant_data_key` (above).
- Moving spec 0007's settings bus onto this outbox (settings are tenant data, on the tenant shard).
- Acknowledgements from subscribers (spec 0015 D1 stands).
- PgBouncer itself: the next roadmap item. This design works through transaction pooling, and its tests run through PgBouncer once that CI job exists.
