# Spec 0003 — Product entitlements and the product guard

**Status:** Accepted (2026-10-05) · **Phase:** 0 · Implements ADR-020 items 1–2 (product declarations and server-side entitlements). Runtime roles (`PRODUCTS=…`), per-role pools and the isolation load test arrive with Phase 4b.
Every AC ID appears in at least one test name.

## Products

`core` · `admissions` · `bursary` · `academics` · `teaching` · `assessment` · `student_affairs` · `helpdesk` · `reporting` (catalog in `packages/contracts`). **`core` is always on** and can't be disabled.

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| P1 | *Two levels.* The platform stores, per tenant and product, **entitled** (granted by UniVarse, from the plan) and **enabled** (switched on by the institution). A product is active only if it's entitled **and** enabled. `core` is always active. |
| P2 | *Every route declares a product.* Every tenant route carries `@Product('…')` (class or method). **The app refuses to boot** if any tenant route lacks one. Only `@NoTenant()` routes (health, platform) are exempt. |
| P3 | *Inactive ⇒ 404, before authentication.* A request to a route of an inactive product gets `404 resource.not_found`, the same as a non-existent route, whether or not the caller is signed in. Guard order: tenant → **product** → access. |
| P4 | *IT Admin switches within the plan.* `PUT /api/v1/admin/products/{product}` with `{ enabled }`. Requires `settings.product.manage` (privileged ⇒ MFA, step-up flagged). Enabling a product that isn't entitled → `409 product.not_entitled`. Disabling `core` → `422 product.core_required`. Unknown product → `404`. |
| P5 | *Audited.* Every enable/disable writes a tenant audit event (`settings.product.enabled` / `.disabled`) with before/after, in the same transaction as the change, as far as possible across two databases (see design note). |
| P6 | *Visible to clients.* `GET /api/v1/products` (any signed-in member) lists the tenant's **active** products for navigation. `GET /api/v1/admin/products` (`settings.product.manage`) lists all products with entitled/enabled flags. |
| P7 | *Fast and fresh enough.* Active products are cached per tenant (TTL 30 s, the same bound as the tenant cache, [02 §7.3](../02-architecture.md)). A change invalidates the cache on the instance that made it immediately. Other instances converge within the TTL (documented, not hidden). |
| P8 | *Tenant-scoped.* An IT Admin can only change their own institution's products, since the tenant comes from the Host. No request can read or change another tenant's entitlements. |
| P9 | *Platform sets entitlements.* Entitlements are written by a platform-side service. Until the console exists, by seed / platform script, never by a tenant endpoint. A tenant can never grant itself an entitlement. |
| P10 | *Jobs respect products (contract for the worker).* Every outbox event and job carries its `product`. The worker (spec 0002 Part B) skips the events of inactive products, leaving them pending, and processes them once the product is active again. Tested in the Part B PR. |

## Design note: two databases
Entitlements live in the **platform DB** (`tenant_product`). Audit events live in the **tenant shard**. They can't share one transaction. The update writes the platform row first, then the tenant audit event. If the audit write fails, the platform change is **compensated** (reverted) and the request fails. A test proves no unaudited change remains.

## Implementation notes (decided while building)
- **Database backstops.** `tenant_product` has two CHECK constraints: the product must be in the catalog, and `enabled` requires `entitled`. A regression in application code still can't produce an active product outside the plan.
- **No-ops.** Setting a product to its current value returns 200 with the state and writes **no** audit event, because nothing changed. Disabling a product that isn't entitled is also a no-op, not an error.
- **Concurrency.** The update is conditional on the value that was read, and when enabling, on `entitled = true`. A lost race with another admin, or with a platform revoking the entitlement, gets `409 product.changed`.
- **Compensation residual risk.** If the audit write fails *and* the compensating platform update also fails, the error is logged loudly (`Compensation failed: product change is unaudited`) for reconciliation. This needs two independent databases to fail in sequence. Durable reconciliation arrives with the outbox (spec 0002 Part B).
- **Step-up on the overview.** `settings.product.manage` is step-up flagged, so `GET /api/v1/admin/products` needs a fresh step-up too. This is the same "sudo mode for settings pages" trade-off as GitHub's. It also closes the spec 0001 S9 gap, since this is the first real route with a `stepUp` permission.
- **No ETag / `If-Match`** on the PUT. The body is an absolute value, so the request is idempotent, and the conditional update covers races. The [06 §5](../06-api-guidelines.md) rule targets multi-field settings edits, where a lost update is possible.
- **Guard order is asserted** by a unit test on the registered `APP_GUARD` providers (tenant → product → access), so removing or reordering the product guard fails CI. This holds even before a non-core route exists.
- **Seed plans.** `demo-uni` is entitled to admissions, bursary, academics and helpdesk. `test-poly` is entitled to admissions. None are enabled. Re-seeding resets entitlements and never the institution's switches, except that revoking an entitlement also disables the product, as the CHECK constraint requires.

## Out of scope (tracked)

| Gap | Milestone |
|-----|-----------|
| Console UI for entitlements | Phase 1 console |
| `PRODUCTS=…` runtime roles, per-role pools, isolation load test | Phase 4b |
| Cross-instance cache invalidation (Valkey pub/sub) | Before multi-instance production (same as tenant lifecycle) |
| First non-core routes (an end-to-end 404 test through a real non-core controller) | First non-core module. Until then the guard is unit-tested against non-core route metadata |
