# Spec 0004 — Generic tenant-isolation sweep (dynamic DB layer)

**Status:** Accepted (2026-10-05) · **Phase:** 0 (exit criterion: "the cross-tenant suite passes, all 5 layers") · Closes the layer-2 gap in [12 §3.1](../12-testing-strategy.md).
Every AC ID appears in at least one test name.

## Why
Layer 2 currently has hand-written cases on four tables. Every table added later must be covered **without anyone remembering to add it**, and a sweep over empty tables proves nothing.

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| I1 | *Discovered, not listed.* The sweep finds tenant tables from `pg_catalog` (every `public` table with a `tenant_id` column), using the same rule as the static checker. The test fails if a discovered table has no fixture, or a fixture names a table that doesn't exist. Adding a tenant table without adding it to the sweep is a red build. |
| I2 | *Non-vacuous.* Each tenant table gets at least one row in **two fresh tenants A and B** (random ids, not the seeded tenants). Rows are written as the app role under the owning tenant's RLS context. Before any negative check, each tenant must see its own rows. |
| I3 | *Read.* Under A: `SELECT … WHERE tenant_id = B` returns 0 rows, and an unfiltered `SELECT` returns only A's rows. |
| I4 | *Update.* Under A: an `UPDATE` targeting B's rows affects 0 rows. For each table the update touches a column the app role may update (from column privileges). Tables the app can't update at all (append-only) must instead be refused by grants, and the test asserts which applies. |
| I5 | *Move.* Under A: re-pointing one of A's rows to `tenant_id = B` is refused by the policy's `WITH CHECK`. If the app can't update `tenant_id`, grants refuse it, and the test asserts which. |
| I6 | *Delete.* Under A: a `DELETE` targeting B's rows affects 0 rows (or is refused by grants for append-only tables). B's rows are all still present afterwards. |
| I7 | *Insert.* Under A: inserting a copy of an A row with `tenant_id = B` fails with the row-level-security violation, not some other error. |
| I8 | *No context.* With no tenant set: `SELECT` returns 0 rows and the insert copy fails, for every table. |
| I9 | *Real role.* The sweep runs as `univarse_app` and asserts that the role has neither `BYPASSRLS` nor superuser. |

## Design notes
- Generic SQL, one code path for every table: the insert copy uses `jsonb_populate_record` over the source row with `id` and `tenant_id` replaced. Postgres evaluates the RLS `WITH CHECK` before unique and foreign-key checks, so the expected error is unambiguous.
- Fixtures are built through the Prisma tenant client under the owning tenant's context. Rows that need a parent (session → user, …) get one from the same tenant, so composite FKs hold.
- Rows of the random test tenants that the app role can't delete (`audit_event`, `outbox_event` are append-only) remain. They belong to no real tenant and RLS hides them from everyone else.
- **Negative control** (run manually, recorded in the PR): disabling forced RLS on one table makes the sweep fail for that table.

## Implementation notes
- **Negative controls run (2026-10-05)**, each against the local DB as the migrator, then restored, with the RLS checker green afterwards:
  1. RLS disabled on `setting`: I3–I8 fail (6 tests).
  2. `setting` policy with `WITH CHECK (true)`: I7 and I8 fail. I5 (move) still passes, correctly. For an `UPDATE`, Postgres also checks the new row against the policy's `USING`, so moving a row out of the tenant is refused while `USING` holds. A move needs **both** clauses broken, and a weak `WITH CHECK` alone is caught by the insert checks.
  3. A new table `sweep_probe (id, tenant_id)` without a fixture: I1 fails, so a new table can't slip past.
- Grants vs RLS per table, asserted by the sweep:
  - `audit_event` is fully append-only for the app role, so update, move and delete are refused by grants.
  - `outbox_event` lets the app update only its delivery columns. RLS confines those updates (I4), and grants refuse moving and deleting.
  - The other 12 tables rely on RLS for every operation.

## Out of scope (tracked)

| Gap | Milestone |
|-----|-----------|
| Layer 3 route-table sweep (B's resource ids with A's session → 404) | First routes that take tenant resource ids (Phase 1–2) |
| Layer 5 file/presigned-URL isolation | Files module (Phase 0) |
