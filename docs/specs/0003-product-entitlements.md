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

## Out of scope (tracked)

| Gap | Milestone |
|-----|-----------|
| Console UI for entitlements | Phase 1 console |
| `PRODUCTS=…` runtime roles, per-role pools, isolation load test | Phase 4b |
| Cross-instance cache invalidation (Valkey pub/sub) | Before multi-instance production (same as tenant lifecycle) |
| First non-core routes (an end-to-end 404 test through a real non-core controller) | First non-core module. Until then the guard is unit-tested against non-core route metadata |
