# Spec 0009 — API route sweep: tenant isolation through every route (layer 3)

**Status:** Accepted, revision 2 (2026-10-06, after owner review) · **Phase:** 0 (exit criterion: "the cross-tenant suite passes, all 5 layers") · Closes the layer-3 gap in [12 §3.1](../12-testing-strategy.md) for today's routes, and makes every future route covered by default.
Every AC ID appears in at least one test name.

## Why
Layer 3 is partial: a handful of hand-written checks cover host resolution, a session replayed on another tenant's host, and the users list. Every route added later must be covered **without anyone remembering to add it**, the same way the DB sweep (spec 0004) covers every table.

**Starting point:**
- **No record-by-id routes yet.** Today no route loads a tenant record by its id. The only path parameters are catalog keys (`admin/products/:product`, `settings/:key`). Real resource-by-id coverage is therefore reported as **"N/A: 0 routes"**, separately from the synthetic controls that prove the machinery works.
- **Classify and refuse the unknown.** The sweep classifies every route, tests each for the ways **it** can leak, and fails the build for any route it can't classify.
- **Never vacuous.** No isolation check counts unless the same fixture first proves the **legitimate** operation succeeds. A write that returns 428 has not tested write isolation.

## Terms
- **Route table:** every HTTP route the API serves, captured from structured registrations (RS1), never written by hand.
- **Route declaration:** one per route, keyed by `METHOD path`. It holds the route's **authentication kind**, its **isolation classes** (one or more), and a **fixture**. The fixture is the exact legitimate request and its exact expected outcome.
- **Marker:** a value seeded under one tenant that must never surface through another tenant's host, session or challenge. Random per run, in **two tenants A and B**.
- **Finding:** a structured failure the sweep reports: `{ route, rule, location, marker | detail }`. The checks are functions that return findings. Test assertions are made on findings, so a control can assert the **exact** leak (RS8).

## Authentication kinds (separate from isolation classes)
| Kind | Credential | Routes today |
|---|---|---|
| `none` | Not tenant-scoped | `GET /health/live`, `GET /health/ready` |
| `public` | None; the Host decides the tenant | `POST /auth/login`, `POST /auth/activation/request`, `POST /auth/activation/confirm`, `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm`, `GET /tenant/public-profile` |
| `mfa-challenge` | The `__Host-uv_mfa` challenge cookie set by a password login, before a session exists. The guard sees the route as `@Public()`; the handler requires the cookie itself | `POST /auth/mfa/verify` |
| `restricted-session` | A session that may only finish enrolling two-step sign-in (spec 0001 M8), or a full session (`@AllowRestricted()`) | `POST /auth/mfa/totp/enrol`, `POST /auth/mfa/totp/confirm`, `POST /auth/logout`, `GET /auth/me` |
| `session` | A full session, plus the route's permission, MFA and step-up from the catalog (`step-up` itself refuses a restricted session, S8) | everything else |

## Isolation classes (a route can have several)
| Class | Leak it guards against | Routes today |
|---|---|---|
| `public-auth` | An account action (login, activation, reset, challenge) reaching the same username in another tenant | the five auth `public` routes, `mfa/verify` |
| `self` | Acting on, or returning, another user's data, in the same tenant or another | `me`, `logout`, `step-up`, `mfa/verify`, `mfa/totp/*`, `mfa/recovery-codes/regenerate` |
| `collection` | Listing another tenant's data | `GET /users`, `GET /settings`, `GET /admin/products`, **`GET /products`** (active products differ by tenant plan), `GET /tenant/public-profile` |
| `keyed` | Reading or changing another tenant's item named by a catalog or registry key | `GET/PUT/DELETE /settings/:key`, `PUT /admin/products/:product` |
| `resource` | Reading or changing another tenant's record named by its id, from any location | **none yet: N/A: 0 routes** |

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| RS0 | *Baseline first, exact expectations.* Each fixture first performs the **legitimate** operation as tenant A. That means valid inputs, CSRF headers, permission, MFA, a fresh step-up, and a current ETag where needed. The fixture asserts the **exact** status and the defined business fields, plus the persisted effect for writes. Ranges such as "200 or 4xx" are not allowed. The isolation checks for a route only run after its baseline passes, and a failing baseline fails the sweep. |
| RS1 | *Discovered from structured registrations.* The test app records every route through Fastify's **`onRoute`** hook (method and URL as registered) and cross-checks it against Nest's controller metadata (`DiscoveryService`).<br>• **Expected framework routes:** the auto-generated `HEAD` twin of each `GET` is listed explicitly, as are any `OPTIONS` routes the framework adds. Each is checked to belong to its parent route.<br>• **Anything else fails**: a route with no declaration, a declaration with no route, or a route Fastify serves that Nest doesn't know about.<br>• `printRoutes()` is used only to print diagnostics on failure. |
| RS2 | *Credentials checked by kind, with exact answers.* For every route whose kind isn't `none` or `public`, the fixture pins the exact status and problem code for these cases:<br>• **missing credential:** no session or challenge;<br>• **A's credential on B's host:** A's session, or A's challenge cookie for `mfa-challenge`;
• **restricted session on a `session` route:** `403 auth.mfa_enrolment_required`. It is accepted **only** on the four `restricted-session` routes, the spec 0001 M8 allow-list including its documented `/me` exception. The test asserts that set exactly.<br>The suspended tenant's host answers 423 `tenant.suspended` on every tenant route. |
| RS3 | *Host is the only tenant source; tenant hints change nothing.* For every route with a passing baseline, the request is repeated with tenant hints:<br>• the header `X-Tenant-Id: <B>`;<br>• the query `?tenantId=<B>`;<br>• `tenantId: <B>` in a JSON body, where the route takes one.<br>Exact response equality is not used, because request ids, timestamps, rotated session tokens and new recovery codes change on every call. Instead the sweep compares:<br>• **business fields:** the fields the fixture defines, such as `{ id, username }` for `me`, or the list of keys and values for settings;<br>• **persisted effects:** row snapshots before and after.<br>The result must match the hint-free baseline, or be the fixture's documented 400 for an unknown body field. It never contains or changes a B marker. Destructive operations (logout, MFA disable, recovery-code regeneration, reset confirm) get an **independent fresh fixture** for each variant, so variants never interfere. |
| RS4 | *Collections never cross.* Each `collection` route, called by a valid A identity on A's host, returns **A's markers**, asserted present (non-vacuous), and **no** B marker. Per-run markers: a user, a settings override, a product state, and a different plan (`GET /products`). `GET /tenant/public-profile` returns A's institution name on A's host and B's on B's. |
| RS5 | *Keyed items are per tenant.* For each `keyed` route:<br>• A and B hold **different** values for the same key, and a read by A returns A's value.<br>• A's write uses a fresh step-up, a current ETag and a valid value, and must **succeed** (exact 200 and the new value).<br>• After the write, B's stored state is unchanged, compared field by field with its snapshot.<br>• A key of a product A doesn't have active is the documented 404. |
| RS6 | *Resources by id, from every location (machinery now).* A `resource` declaration names **every** place a record reference can be supplied: path, query, headers and body (OWASP object-level authorisation).<br>• **Baseline:** A succeeds on its own record.<br>• **Cross-tenant:** for each location, B's existing record id with A's credentials must give **exactly the same documented error behaviour as a nonexistent id** (same status, same problem code, same body shape apart from `requestId`), so there is no existence oracle. B's record must be unchanged afterwards.<br>• **Documented behaviour** is `404 resource.not_found`, unless the route's own spec states otherwise.<br>• **Coverage report:** real resource routes are reported as **"N/A: 0 routes"**, separately from the synthetic controls. |
| RS7 | *Account actions stay with their account and tenant.*<br>**Fixture set-up:** the **same username** is seeded in A and B, with different passwords, emails and MFA secrets, plus a **second user in A** (A2). Each check compares persisted state before and after: account rows, sessions, factors, recovery codes, challenges, and outbox rows (recipients only, never payloads).<br>**Login and challenges:**<br>• Login on A's host with A's password creates a session bound to A's user and A's tenant (checked in the DB).<br>• Login on A's host with B's password fails.<br>• A's MFA challenge can't be completed on B's host, nor with B's code.<br>**Activation and reset:**<br>• A request on A's host queues an email only to A's user's address, in A's outbox.<br>• The code doesn't confirm on B's host.<br>• Confirmation changes only A's user.<br>**Self routes:**<br>• `logout`, `step-up`, MFA enrol, confirm, disable and recovery-code regeneration by A1 change only A1's rows.<br>• A2's sessions, factors and recovery codes are unchanged, and so is B's same-username user.<br>• `me` returns A1 only. |
| RS8 | *The sweep proves itself, safely (negative controls in every run).*<br>**Why not just drop a tenant filter:** forced RLS would still block the read under the app role, so that would plant no leak at all.<br>**The controls:** the test app registers two **test-only** routes. Each loads B's fixture **under B's legitimate tenant context** (`ShardRegistry.tx` as B), then deliberately returns it to A's request:<br>• a leaky `resource` route, by id;<br>• a leaky `collection` route.<br>**Each control is asserted in two steps:**<br>1. Called directly, the route **does** expose B's marker, which proves the control is real.<br>2. The sweep's checker, run against the control, returns **exactly** the expected finding (route, rule RS6 or RS4, B's marker).<br>Any exception, or any other finding, fails the test.<br>**Never in production:** a test boots the **compiled production build** (`dist`, no test overrides) and asserts that its `onRoute` table contains no control route. A static check confirms no `__test` path is compiled into `dist`. |
| RS9 | *Same identities as production.* The sweep runs through the real app (guards, filters, CSRF hook, rate limiting with per-request client IPs) as the app database role, with real sessions. Each of A and B has an MFA-enrolled, stepped-up institution admin and an MFA-enrolled, stepped-up Registrar, plus the RS7 accounts. |

## Design notes
- **Where:** `apps/api/src/route-sweep.int.spec.ts`, with the declarations in `apps/api/src/testing/route-declarations.ts` (test-only, excluded from the build like the other helpers).
- **Route capture:** `createApp` gains a test-only option to attach an `onRoute` collector to the Fastify instance **before** `app.init()`. `main.ts` doesn't use it. The production-build check (RS8) attaches the same collector to the compiled app.
- **Checks as functions:** for example `checkCollection(route, identity, markers) → Finding[]`. The `it.each` tests assert `findings` equals `[]` for real routes, and equals the exact expected finding for each control. Test names carry the route and the RS ID, e.g. `[RS4] GET /api/v1/users: A's markers present, no B marker`.
- **Business fields per fixture:** each declaration names the fields that define its answer (e.g. `data[].username` for users, `data[].{key,value,source}` for settings, `data` for products). Those fields are compared, never the raw body.
- **Persisted effects:** row snapshots are read as the app role under the owning tenant's context (A, A2, and B's same-username user), and sorted. Payloads of encrypted columns are never read; only their presence and key version.
- **Fixtures and clean-up:**
  - Destructive fixtures create their own users, so they never consume shared identities.
  - Product states and settings overrides changed by a fixture are restored through the API, so instance caches are invalidated too.
  - Append-only rows (audit, outbox) remain, as with the DB sweep.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Real `resource` routes (records by id) under RS6. The sweep refuses to pass without their declarations and fixtures | Their first module (Phase 1–2) |
| Resource-scoped authorisation (faculty or department scope against the loaded record, invariant 2) | With scoped grants (Phase 1–2), as an extension of RS6 |
| Layer 5 file isolation (presigned URLs, object keys) | File uploads module |
| Product cache isolation across instances (spec 0003 P7) | With the shared invalidation bus |
