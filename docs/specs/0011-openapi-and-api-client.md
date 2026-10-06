# Spec 0011: OpenAPI contract and the generated `api-client`

**Status:** Draft (2026-10-06), awaiting owner review. D1–D4 below need decisions.
**Phase:** 0 (roadmap: "OpenAPI generation", "`packages/api-client`").
**Builds on:**
- [docs/02 §2](../02-architecture.md): zod → OpenAPI → a typed client;
- [docs/06 §OpenAPI](../06-api-guidelines.md);
- [docs/12](../12-testing-strategy.md): the contract test layer;
- [spec 0009](0009-api-route-sweep.md): real-route discovery.

Every AC ID appears in at least one test name.

## Why
The web app calls the API through hand-typed generics, for example `api<FileView>('GET', …)`. Nothing ties those types to what the API actually returns:
- a renamed field compiles fine and fails at run time;
- an error code the UI switches on can change silently.

docs/02 and docs/06 already promise an OpenAPI document generated from zod, and a generated client that the web **must** use. Neither exists yet.

**The goal:** one machine-checked contract for the 30 real routes. It is generated from the running application, so it cannot describe a route that doesn't exist or miss one that does. It is consumed by the web app, and verified against real responses in CI.

## What exists today (2026-10-06, `main` at `3aaf809`)
- **Requests:** validated by `parse(schema, body)` (`shared/http/validate.ts`) with strict zod schemas. Those schemas are **defined inside each controller**, not in `packages/contracts` as docs/06 says.
- **Responses:** have **no schema**. Services return plain objects.
- **Errors:** Problem Details (`application/problem+json`) from `ProblemFilter`, with `type`, `title`, `status`, `code`, `detail?`, `errors?` and `requestId`.
  - Codes thrown today, by area:

    | Area | Codes |
    |---|---|
    | Access | `auth.unauthenticated`, `auth.forbidden`, `auth.mfa_required`, `auth.mfa_enrolment_required`, `auth.step_up_required` (428) |
    | Credentials and MFA | `auth.invalid_credentials`, `auth.mfa_invalid`, `auth.activation_invalid`, `auth.reset_invalid`, `auth.password_rejected`, `auth.mfa_enrolment_expired`, `auth.mfa_already_enrolled`, `auth.mfa_not_enrolled`, `auth.step_up_second_factor_required` |
    | Request and preconditions | `request.invalid`, `request.rate_limited`, `request.csrf_rejected`, `precondition.required` (428), `precondition.failed` (412) |
    | Tenant | `tenant.not_found`, `tenant.suspended` (423) |
    | Resources | `resource.not_found`, `settings.unknown_key`, `product.changed`, `product.not_entitled`, `product.core_required` |
    | Files | `file.not_ready`, `file.quota_exceeded`, `file.upload_incomplete`, `file.too_large`, `file.type_not_allowed` |

  - **Inconsistency found:** the CSRF hook writes `type: …/request.csrf-rejected` (a hyphen), while its `code` is `request.csrf_rejected`. Everything else uses `problemType(code)`.
- **Authentication:**
  - the session cookie is `__Host-uv_sid`;
  - the MFA challenge cookie `__Host-uv_mfa` is set by `login` when a second factor is needed, and read and cleared by `mfa/verify`.
- **CSRF:**
  - every unsafe method under `/api/` needs `Sec-Fetch-Site: same-origin`;
  - without Fetch Metadata, an `Origin` header matching the Host;
  - otherwise `403 request.csrf_rejected`.
- **ETags:** settings writes need `If-Match: "v<n>"`. A missing header is `428 precondition.required`; a stale one is `412 precondition.failed`.
- **Binary download:** `GET /files/{id}/content` returns the bytes with the detected type, `content-length`, `content-disposition: attachment` and the sandbox CSP. The web app links to it with an `<a href>`, not with `fetch`.
- **Not part of the API's contract:** the presigned POST goes **to storage**, not the API. Only the slot response that carries its URL and fields is.
- **Web call sites:**
  - client side, 17 calls in 10 files through `lib/client-api.ts`;
  - server side, 8 calls through `lib/server-api.ts`, GET only;
  - every response type is hand-written.
- **Version skew:** `apps/api` declares `zod ^4.1.0` and `packages/contracts` declares `^4.6.5`. One version must be resolved before schemas are shared.

## Acceptance criteria
| ID | Criterion |
|---|---|
| OA1 | *Generated from the application, not written by hand.* The generator boots the real Nest app (as the route sweep does) and builds OpenAPI 3.1 from **application metadata**: routes from Nest's `DiscoveryService`, and for each one its permission, `@Public`, `@RequireStepUp`, `@Product` and contract declaration, read from the same metadata the guards enforce. The result is written to `packages/api-client/openapi.json`. |
| OA2 | *Complete, both ways.* Every real route (today 30, the same set as spec 0009) has exactly one operation, and every operation corresponds to a real route. A route without a contract declaration fails generation and names the route. Test-only routes (`route-controls.ts`) and `/health/*` are excluded explicitly, by name, never by pattern. |
| OA3 | *Requests from the schemas that validate them.* Each operation's request body, path and query parameters come from **the same zod schema** the handler's `parse` uses: moved into `packages/contracts`, converted with zod 4's JSON Schema output. They are strict (`additionalProperties: false`). A test proves the documented schema and the runtime validator are the same object. |
| OA4 | *Responses for every status, including errors.* Each operation lists its success response (schema, plus headers such as `ETag` and `Set-Cookie`), and **every error it can produce** as `application/problem+json` with the shared `Problem` schema. Each `code` is listed as an enum on that response. The errors come from the guards (401, 403, 404, 423, 428 step-up), from validation (400 `request.invalid` with `errors[]`), from CSRF (403 on unsafe methods), from rate limits (429 with `Retry-After`) and from the use case. |
| OA5 | *Authentication described accurately.* Security schemes: `session` (cookie `__Host-uv_sid`) and `mfaChallenge` (cookie `__Host-uv_mfa`, only on `mfa/verify`). Public routes have `security: []`. Endpoints that set or clear cookies document `Set-Cookie`, with its attributes described and no values. Extensions carry `x-permission`, `x-step-up`, `x-product`, `x-rate-limit` and `x-idempotency` (docs/06), and say which operations allow an enrolment-only session (spec 0001 M15′). |
| OA6 | *CSRF, ETags and binary responses described accurately.* Every unsafe operation documents its CSRF requirement (`x-csrf: same-origin`) and its `403 request.csrf_rejected` response. Settings `GET` documents the `ETag` header; settings `PUT` and `DELETE` document a required `If-Match` with 412 and 428. `GET /files/{id}/content` documents `200` with `application/pdf`, `image/png` and `image/jpeg` as `format: binary`, plus `Content-Disposition`, `Content-Length` and `409 file.not_ready`. |
| OA7 | *One error shape.* The CSRF rejection's `type` is fixed to `problemType('request.csrf_rejected')`. A test asserts, for every documented error response, that `type` equals `problemType(code)`. |
| OA8 | *A generated client, actually used.* `packages/api-client` exports:<br>• the generated `paths` types (`openapi-typescript`);<br>• a thin typed fetch wrapper (D2);<br>• a typed `contentUrl(id)` path builder for the binary download.<br>**Every** API call in `apps/web` goes through it: `client-api.ts` and `server-api.ts` become transports underneath it, and hand-written response types are deleted. The documents flow (list, slot, complete, poll, delete, download link) is on it end to end. A lint rule forbids `fetch('/api/…')` and literal `/api/v1` paths outside the client. |
| OA9 | *Stale generated files fail CI.* CI runs `pnpm contracts:gen`, then `git diff --exit-code` on `openapi.json` and the generated types. A contract change without regenerating fails, with a message naming the command. |
| OA10 | *Real responses verified against the schemas.* In the API integration tests, every `h.call` response is validated against its operation: status documented, media type, body schema, and any documented headers. JSON is checked with Ajv for 2020-12. For binary, the media type and `Content-Length` are checked. An undocumented status or a body mismatch fails the test that made the call. The route sweep's run alone touches all 30 routes. A coverage line, `[openapi-conformance] operations N/30, statuses seen M/K`, prints the documented (operation, status) pairs that were never exercised, so gaps are visible rather than silent. |
| OA11 | *Negative controls.* The conformance check must actually catch drift. Each change below must fail a test:<br>• renaming a response field;<br>• returning an undocumented status;<br>• removing a documented error code from the enum;<br>• making a strict request schema loose;<br>• deleting a route's contract declaration. |
| OA12 | *Breaking changes are visible.* CI runs an OpenAPI diff (oasdiff) of the PR against `main` and prints breaking changes in the job summary. Whether it blocks is D4. |

## Design notes
- **Declaring a contract.** Each handler gets one `@Contract(op)`. `op` lives in `packages/contracts/src/api/<module>.ts` with `operationId`, `request`, `responses` (status → schema or `binary`), `errors` (codes), `headers` and `cookies`.
  - It holds **no** permission or step-up data. Those are read from the existing decorators, so the documentation can't disagree with what is enforced.
  - The handler's `parse` takes `op.request.body`.
- **The generator** is a script in `apps/api`, sharing the harness's app bootstrap:
  - it boots, collects routes from `DiscoveryService`, joins each to its `@Contract` and guard metadata, and emits the document;
  - Fastify `onRoute` capture is the cross-check (spec 0009 RS1), so a route registered outside Nest is still noticed.
- **The client** (D2): `openapi-typescript` produces `paths`, and a wrapper gives `api.GET('/api/v1/files/{id}', { params })`.
  - Its result is `{ ok: true, data }` or `{ ok: false, problem }`, with `problem.code` typed to that operation's enum.
  - Browser calls send nothing extra; same-origin fetch already sends `Sec-Fetch-Site`.
  - Server calls keep `server-api.ts`'s header forwarding (Host, X-Forwarded-*, cookie) as the transport.
- **Committed artifact, no runtime endpoint.** `openapi.json` is committed and reviewed in diffs. docs/06's "`/api/v1/openapi.json` in non-prod only" is **dropped**: the committed file serves the same purpose without adding a route.
- **Steps, each green before the next:**
  1. zod alignment, and schemas moved to contracts;
  2. `@Contract` and the generator, with OA2 completeness;
  3. response schemas, plus conformance in the tests (OA10, OA11);
  4. `api-client` and the web migration, the documents flow first (OA8);
  5. the CI gates (OA9, OA12).

## Decisions needed
| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How to generate | **(a)** Our own `@Contract` metadata + zod 4's native JSON Schema output, assembled from Nest's `DiscoveryService`. **(b)** `@nestjs/swagger`'s `SwaggerModule.createDocument` with the `nestjs-zod` adapter. | **(a).** It is still generated from application metadata, the way (b) would be, but zod stays the single source with no DTO classes. It adds no decorator layer that can drift from the guards, and no extra dependency. (b) is the fallback if (a)'s generator grows past about 300 lines. |
| D2 | Client wrapper | **(a)** `openapi-fetch` (about 6 kB, typed from `paths`). **(b)** A hand-written wrapper over the generated types. **(c)** A full codegen client (e.g. orval). | **(a):** small, maintained, no runtime codegen. (c) generates much more code than this app needs. |
| D3 | Validate responses at run time in the client too? | **(a)** No; validated in CI only (OA10). **(b)** In development builds only. | **(a)** for now. The browser bundle stays small for low-end Android, and CI already checks the server side. |
| D4 | Do breaking changes block? | **(a)** Report only. **(b)** Block unless the PR carries an `api-breaking` label and a changelog note. | **(a)** until there is a client we don't deploy ourselves (the mobile app, or third-party integrations). The web app and API ship together, so breaking changes are coordinated in the same PR. |

## Docs to update in the same change
- **docs/06 §OpenAPI:** where the artifact lives; the runtime endpoint dropped; the extensions list; schemas in `packages/contracts`, as finally true.
- **docs/02 §2 and the repo layout:** `packages/api-client` exists.
- **docs/12:** the contract layer (generation, conformance, oasdiff report).
- **docs/17 §3:** the `@Contract` rule and the lint rule.
- **CLAUDE.md:** `pnpm contracts:gen` exists and is gated in CI.
- **README:** a status row.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Event (outbox) schema contracts and compatibility checks | With the first cross-product event consumer |
| Publishing the API docs (rendered reference) | When an external integrator exists |
| Runtime response validation in the client (D3 b) | If CI conformance ever misses a real bug |
| Cross-instance product cache (spec 0003 P7), key-forget broadcast and shred ledger (spec 0006) | Unchanged: on the invalidation bus and the staging backups. File isolation alone does not close layer 5 |
