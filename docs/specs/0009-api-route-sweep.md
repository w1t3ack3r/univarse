# Spec 0009 — API route sweep: tenant isolation through every route (layer 3)

**Status:** Draft (2026-10-06) · **Phase:** 0 (exit criterion: "the cross-tenant suite passes, all 5 layers") · Closes the layer-3 gap in [12 §3.1](../12-testing-strategy.md) for today's routes, and makes every future route covered by default.
Every AC ID appears in at least one test name.

## Why
Layer 3 is partial: a handful of hand-written checks cover host resolution, a session replayed on another tenant's host, and the users list. Every route added later must be covered **without anyone remembering to add it**, the same way the DB sweep (spec 0004) covers every table.

An honest starting point: **today no route loads a tenant record by its id.** The only path parameters are catalog keys (`admin/products/:product`, `settings/:key`). So the textbook check ("tenant B's record id with tenant A's session → 404") has no real route to run against yet, and a sweep built only on that would pass while proving nothing. This sweep therefore:
- **classifies** every route;
- tests each class for the way **it** could leak (lists, keyed reads and writes, sessions, tenant hints);
- **proves itself** against deliberately leaky test-only routes;
- **fails the build** for any route it can't classify. The first route that takes a record id can't land without its cross-tenant check.

## Terms
- **Route table:** every HTTP route the API serves. It is discovered from the running app (Nest metadata, cross-checked against Fastify's own route list), never written by hand.
- **Route class:** what the sweep expects of a route. Declared once per route in the sweep's classification, keyed by `METHOD path`.
- **Marker:** a value seeded under one tenant that must never show up through another tenant's host or session. Fresh random markers for each run, in **two tenants A and B**.

## Route classes
| Class | Meaning | Today |
|---|---|---|
| `no-tenant` | Not tenant-scoped at all | `GET /health/live`, `GET /health/ready` |
| `public` | Anyone on the host; the Host decides the tenant | login, activation, password reset, `GET /tenant/public-profile` |
| `self` | Acts only on the signed-in user's own session or account | `me`, `logout`, `step-up`, `mfa/*`, `GET /products` |
| `collection` | Lists tenant data | `GET /users`, `GET /settings`, `GET /admin/products` |
| `keyed` | Reads or writes one item named by a catalog or registry key (not a record id) | `GET/PUT/DELETE /settings/:key`, `PUT /admin/products/:product` |
| `resource` | Reads or writes one tenant record named by its **id** | **none yet** (the first arrives with Phase 1–2 routes) |

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| RS1 | *Discovered, not listed.* The sweep builds the route table from the running app. The test fails if a discovered route has no class, or if a class names a route that doesn't exist. The route set Nest reports and the set Fastify serves must match, so nothing is registered outside Nest's view. |
| RS2 | *Deny by default, proven by enumeration.* Every route that isn't `no-tenant` or `public` answers **401** without a session, and **401** with tenant A's valid session presented on tenant B's host. The suspended tenant's host answers 423 on every tenant route. |
| RS3 | *Host is the only tenant source.* For every route, adding tenant hints (`X-Tenant-Id: <B>`, `?tenantId=<B>`, and `tenantId: <B>` in a JSON body where the route takes one) never changes what A's session sees or does. The response either equals the response without hints, or is a 400 for an unknown field. It never contains a B marker. |
| RS4 | *Collections never cross.* Each `collection` route, called with A's session on A's host, returns A's markers and **no** B marker. Markers are seeded per run: a user, a settings override and a product state that differ between A and B. |
| RS5 | *Keyed items are per tenant.* For each `keyed` route: A and B hold different values for the same key, and a read with A's session returns A's value. A write with A's session changes A only: B's stored state is byte-for-byte unchanged afterwards. A key belonging to a product A doesn't have active is 404. |
| RS6 | *Resources by id (machinery now, routes later).* Each `resource` route declares how to create a record in a given tenant. The sweep creates one in B and calls the route with A's session and B's id: the answer must be **404** (not 403, which would confirm the record exists), and B's record must be unchanged. A `resource` route with no fixture fails the build (RS1). |
| RS7 | *Self routes stay self.* Each `self` route, called with A's session, never returns or changes another user's data in A, and never anything in B. For `me`: the user's own id only. For `mfa/*` and `step-up`: they act on the caller only (the existing MFA tests cover the details; the sweep asserts no B marker and no other user's id). |
| RS8 | *The sweep proves itself (negative controls, run in every test run).* The test app adds two **test-only** routes that are never in the production build: a deliberately leaky `resource` route (it reads by id with no tenant filter) and a leaky `collection` route (it lists across tenants). The sweep must report **both** as failures, and the test asserts that it does. A sweep that can't catch a planted leak fails. |
| RS9 | *Same identities as production.* The sweep runs through the real app (guards, filters, the CSRF hook) as the app database role, with real sessions: A and B each have an MFA-enrolled, stepped-up admin and a Registrar. |

## Design notes
- **Where:** `apps/api/src/route-sweep.int.spec.ts`, alongside the other API integration tests.
- **Route table:** Nest's `DiscoveryService` lists controllers, plus each handler's path and method metadata. Fastify's `printRoutes` cross-checks the result (RS1). The classification is a map from `METHOD path` to a class plus its fixture, kept beside the sweep, like the DB sweep's per-table fixtures.
- **Negative controls (RS8):** a small test module registered only through `AppOverrides` in the test app, the same mechanism as the settings test registry. It uses the raw platform/tenant clients with no tenant filter on purpose. A static check confirms the production build contains no `__test` path.
- **Markers:** random per run (`ZZ-SWEEP-<run>-A`), seeded in the seeded tenants under their own RLS context. Each test restores what it changed. Products are switched back, and setting overrides are reset through the API.
- **Expected answers per class**, so a failure says which rule broke:
  - `public`: 200 or 4xx without a session; never another tenant's data.
  - `self`: 401 or 200.
  - `collection`: 200 with only A's markers.
  - `keyed`: 200, 404, 412 or 428 depending on the route's preconditions. The sweep supplies a fresh ETag and a stepped-up session, so it reaches the real write.
  - `resource`: 404 for B's id.
- **One sweep, one test file.** The checks are generated per route (`it.each` over the table), so test names carry the route and the RS ID. Example: `[RS4] GET /api/v1/users returns no B marker`.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Real `resource` routes (records by id) under RS6 | Their first module (Phase 1–2). The sweep refuses to pass without a fixture |
| Resource-scoped authorisation (faculty or department scope against the loaded record, invariant 2) | With scoped grants (Phase 1–2), as an extension of RS6 |
| Layer 5 file isolation (presigned URLs, object keys) | File uploads module |
| Cache isolation for the product cache across instances (spec 0003 P7) | With the shared invalidation bus |
