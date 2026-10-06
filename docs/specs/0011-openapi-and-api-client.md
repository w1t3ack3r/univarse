# Spec 0011: OpenAPI contract and the generated `api-client`

**Status:** Accepted (2026-10-06), owner review. D1–D4 decided, with conditions written into the criteria.
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

**The goal:** one machine-checked contract for every real route. It is generated from the running application, so it cannot describe a route that doesn't exist or miss one that does. It is consumed by the web app, and verified against real HTTP responses in CI.

## What exists today (2026-10-06, `main` at `3aaf809`)
- **Routes:** 30 real routes, the same set spec 0009's sweep discovers. This is **today's baseline, not a fixed number**:
  - the 28 routes under `/api/v1`;
  - **plus the two health routes** (`GET /health/live`, `GET /health/ready`).

  Nest declares 32. The other two are the sweep's test-only control routes (`testing/route-controls.ts`), registered only in that test.
- **Requests:** validated by `parse(schema, body)` (`shared/http/validate.ts`) with strict zod schemas. Those schemas are **defined inside each controller**, not in `packages/contracts` as docs/06 says.
- **Responses:** have **no schema**. Services return plain objects, and some fields are serialized differently from their in-memory type (for example, `bigint` and `Date`).
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

  - **Correction (step 3):** the draft listed the CSRF hook's `type: …/request.csrf-rejected` as inconsistent with its code. It isn't: `problemType()` already writes `_` as `-` in the URL, so the hook's value equals `problemType('request.csrf_rejected')`. The real issue was a hard-coded URL; the hook now calls `problemType`.
- **Authentication:**
  - the session cookie is `__Host-uv_sid`;
  - the MFA challenge cookie `__Host-uv_mfa` is set by `login` when a second factor is needed, and read and cleared by `mfa/verify`.
- **CSRF:**
  - every unsafe method under `/api/` needs `Sec-Fetch-Site: same-origin`;
  - without Fetch Metadata, an `Origin` header matching the Host;
  - otherwise `403 request.csrf_rejected`.
- **ETags:** settings writes need `If-Match: "v<n>"`. A missing header is `428 precondition.required`; a stale one is `412 precondition.failed`.
- **Binary download:** `GET /files/{id}/content` returns the bytes with the detected type, `content-length`, `content-disposition: attachment` and the sandbox CSP. The web app links to it with an `<a href>`, not with `fetch`.
- **Presigned upload:** this request goes **directly to storage**, not to the API.
  - It is sent with `XMLHttpRequest`, for progress, from `DocumentsPanel.tsx`.
  - It is not an API operation. Only the slot response that carries its URL and fields is.
- **Web call sites:**
  - client side, 17 calls in 9 files through `lib/client-api.ts`;
  - server side, 8 calls through `lib/server-api.ts`, GET only;
  - every response type is hand-written.
- **How failures are handled today** (D3: preserve, and close the gap):
  - **Browser:**
    - a network failure → `ApiError(0, 'network.offline')`;
    - a Problem Details response → `ApiError(status, code, requestId, fieldErrors)`, with the user message chosen by `code`, never by `detail`;
    - **gap:** a non-JSON error body (for example, a proxy's 502 page) makes `JSON.parse` throw a raw `SyntaxError`.
  - **Server:**
    - a network failure throws, and the caller decides what it means;
    - a non-JSON body becomes `body: null`, with the status kept and the request ID read from the `x-request-id` header.
- **Version skew:** `apps/api` declares `zod ^4.1.0` and `packages/contracts` declares `^4.6.5`.

## Acceptance criteria
| ID | Criterion |
|---|---|
| OA1 | *Generated from the application, with an explicit target.*<br>• **Source:** the generator boots the real Nest app (as the route sweep does) and builds the document from **application metadata**: routes from Nest's `DiscoveryService`, and for each one its `@Contract`, permission, `@Public`, `@RequireStepUp` and `@Product`, read from the same metadata the guards enforce.<br>• **Target: OpenAPI 3.1.1, schemas in JSON Schema draft 2020-12**, converted with zod 4's `z.toJSONSchema` (`target: 'draft-2020-12'`).<br>• **One zod version** across the workspace, pinned through the catalog or overrides; a test fails if two resolve.<br>• **Output:** written to `packages/api-client/openapi.json`. |
| OA2 | *Complete, by comparing route sets, not counts.*<br>• **The sets:** the set of discovered real routes (`DiscoveryService`, cross-checked against Fastify `onRoute` as in spec 0009 RS1) must **equal** the set of documented operations, as `METHOD path` pairs.<br>• **Failure:** any difference fails, naming each route that is missing or extra. No total is hard-coded; 30 is today's baseline.<br>• **Health routes are included:** `GET /health/live` and `GET /health/ready` are documented under the tag `operations`, with `security: []` and no tenant.<br>• **Exclusions:** only the test-only control routes, listed **by name** in one constant, which the test asserts are absent from production module wiring. |
| OA3 | *Requests from the schemas that validate them; responses as serialized.*<br>• **Requests:** each operation's request body, path and query parameters come from **the same zod schema** the handler's `parse` uses, moved into `packages/contracts`. They are converted with `io: 'input'`, so defaults and transforms describe what a client may **send**. Request bodies are strict (`additionalProperties: false`). A test proves the documented schema and the runtime validator are the same object.<br>• **Responses:** each response schema describes the **serialized JSON wire form**, converted with `io: 'output'`. Values whose JSON differs from their in-memory type (`bigint` → string, `Date` → ISO string) are declared as their wire type in the response schema; they are not inferred.<br>• **Unsupported conversions fail generation.** `unrepresentable: 'throw'` is used, and a check fails the generator if any schema in the document is empty (`{}`), `true`, or has no `type`, `const`, `enum`, `$ref` or combinator. Each failure names the operation and the JSON pointer. |
| OA4 | *Responses for every status, including errors.*<br>• **Success:** each operation lists its success response, with its schema and relevant headers.<br>• **Errors:** it also lists **every error it can produce** as `application/problem+json` with the shared `Problem` schema, each `code` listed as an enum on that response.<br>• **Where errors come from:**<br>&nbsp;&nbsp;– the guards: 401, 403, 404, 423, and 428 for step-up;<br>&nbsp;&nbsp;– validation: 400 `request.invalid` with `errors[]`;<br>&nbsp;&nbsp;– CSRF: 403 on unsafe methods;<br>&nbsp;&nbsp;– rate limits: 429 with `Retry-After`;<br>&nbsp;&nbsp;– the use case itself. |
| OA5 | *Authentication described accurately.*<br>• **Security schemes:** `session` (cookie `__Host-uv_sid`) and `mfaChallenge` (cookie `__Host-uv_mfa`, only on `mfa/verify`).<br>• **Public routes** have `security: []`.<br>• **Cookies:** endpoints that set or clear cookies document `Set-Cookie`, describing its attributes (`HttpOnly`, `Secure`, `SameSite`, `Path`, `Max-Age`), never values.<br>• **Extensions:** `x-permission`, `x-step-up`, `x-product`, `x-rate-limit` and `x-idempotency` (docs/06), plus which operations allow an enrolment-only session (spec 0001 M15′). |
| OA6 | *CSRF, ETags, binary and empty responses described accurately.*<br>• **CSRF:** every unsafe operation documents its requirement (`x-csrf: same-origin`) and its `403 request.csrf_rejected` response.<br>• **ETags:** settings `GET` documents the `ETag` header; settings `PUT` and `DELETE` document a required `If-Match`, with 412 and 428.<br>• **Binary download:** `GET /files/{id}/content` documents `200` with `application/pdf`, `image/png` and `image/jpeg` as `format: binary`, plus `Content-Disposition`, `Content-Length` and `409 file.not_ready`.<br>• **Empty responses:** `204` responses document **no content**. |
| OA7 | *One error shape.* The CSRF rejection builds its `type` with `problemType('request.csrf_rejected')`, not a hard-coded URL. The conformance check asserts, for every real error response, that `type` equals `problemType(code)`. |
| OA8 | *A generated client, actually used.*<br>• **What it is:** `packages/api-client` exports types generated by `openapi-typescript` (`paths`) and an `openapi-fetch` client (D2).<br>• **The shared wrapper owns everything below,** so no call site re-implements it:<br>&nbsp;&nbsp;– **Cookies:** in the browser, `credentials: 'same-origin'`. On the server, the transport forwards Host, X-Forwarded-*, the cookie and the user agent, as `server-api.ts` does today.<br>&nbsp;&nbsp;– **CSRF:** relies on same-origin `Sec-Fetch-Site` in the browser; the server transport stays GET-only, or else sets `Origin`.<br>&nbsp;&nbsp;– **Problem Details:** parsed into `ApiError`, with `code` typed to that operation's enum and the message by code.<br>&nbsp;&nbsp;– **`If-Match`.**<br>&nbsp;&nbsp;– **The binary download:** a typed `contentUrl(id)` for the `<a href>`.<br>• **Failure handling is preserved (D3):** a network failure is still `network.offline`. A non-JSON or unexpected response becomes `ApiError(status, 'server.unexpected_response', requestId from the header)`, closing the browser gap; it is no longer a raw `SyntaxError`.<br>• **Coverage:** **every** API call in `apps/web` goes through the client, and the hand-written response types are deleted. The documents flow is on it end to end: list, slot, complete, poll, delete and the download link.<br>• **Lint rule:** forbids `fetch`, `XMLHttpRequest` and literal `/api/` paths outside `packages/api-client` and its transports. **The one exception** is the dedicated presigned-storage upload helper (`apps/web/src/lib/storage-upload.ts`), because that request goes to storage, not the API. The rule names it explicitly. |
| OA9 | *Stale generated files fail CI.* CI runs `pnpm contracts:gen`, then `git diff --exit-code` on `openapi.json` and the generated types. A contract change without regenerating fails, with a message naming the command. |
| OA10 | *Each real HTTP response is verified against its schema.* In the API integration tests, every `h.call` result is checked against its operation **as it went over the wire**: the raw payload and headers, not the object the service returned.<br>• **Status:** it must be documented for that operation.<br>• **Content type:** it must match a documented media type, for example `application/json` or `application/problem+json`.<br>• **Body:** for JSON, the **serialized** payload is parsed and validated with Ajv for 2020-12; for Problem Details, `type` must also equal `problemType(code)`.<br>• **Headers:** the relevant ones are checked:<br>&nbsp;&nbsp;– `ETag` on settings reads;<br>&nbsp;&nbsp;– `Set-Cookie` attributes on auth responses;<br>&nbsp;&nbsp;– `Retry-After` on 429;<br>&nbsp;&nbsp;– `Content-Disposition`, `Content-Length` and the security headers (`nosniff`, the sandbox CSP, `no-store`) on downloads.<br>• **Binary responses:**<br>&nbsp;&nbsp;– the content type is one of the documented binary types;<br>&nbsp;&nbsp;– `Content-Length` equals the payload's byte length;<br>&nbsp;&nbsp;– `Content-Disposition` is `attachment` with a filename;<br>&nbsp;&nbsp;– no JSON parsing is attempted.<br>• **Empty responses:** a `204` must have a zero-length body. Any content on an operation documented as empty fails.<br>• **Failures:** any of these fails the test that made the call.<br>• **Coverage line:** `[openapi-conformance] operations N of M discovered; (operation, status) pairs seen K of L`. It lists the documented pairs never exercised, so gaps are visible and not silent. |
| OA11 | *Negative controls.* The conformance check must actually catch drift. Each change below must fail a test:<br>• renaming a response field;<br>• returning an undocumented status;<br>• removing a documented error code from the enum;<br>• making a strict request schema loose;<br>• deleting a route's contract declaration;<br>• a schema that converts to `{}`;<br>• a `204` that returns a body;<br>• a download whose `Content-Length` doesn't match its payload. |
| OA12 | *Breaking changes are visible and acknowledged (D4: report-only).*<br>• **The diff:** CI runs oasdiff, the PR's `openapi.json` against `main`'s, and writes the full breaking-change list to the job summary.<br>• **What passes:** a **breaking change passes** only when the PR description has an `## API breaking changes` section that names each break and says how older clients cope. An unacknowledged break fails the check, so a break can't slip through unannounced.<br>• **Why older clients matter:** first-party clients can still run older versions in open browser tabs. The usual coping strategy is expand → migrate → contract (CLAUDE.md invariant 9): keep the old field or route for a release. |

## Design notes
- **Declaring a contract.** Each handler gets one `@Contract(op)`. `op` lives in `packages/contracts/src/api/<module>.ts` with `operationId`, `request`, `responses` (status → schema, `binary` or `empty`), `errors` (codes), `headers` and `cookies`.
  - It holds **no** permission or step-up data. Those are read from the existing decorators, so the documentation can't disagree with what is enforced.
  - The handler's `parse` takes `op.request.body`.
- **The generator** is a script in `apps/api`, sharing the harness's app bootstrap:
  - it boots, collects routes from `DiscoveryService`, joins each to its `@Contract` and guard metadata, and emits the document;
  - Fastify `onRoute` capture is the cross-check (spec 0009 RS1), so a route registered outside Nest is still noticed.
- **The client** (D2): `openapi-typescript` produces `paths`, and `openapi-fetch` gives `client.GET('/api/v1/files/{id}', { params })`.
  - The shared wrapper (OA8) adapts its result to the existing `ApiError` contract, so the UI's error handling doesn't change shape during the migration.
- **Committed artifact, no runtime endpoint.** `openapi.json` is committed and reviewed in diffs. docs/06's "`/api/v1/openapi.json` in non-prod only" is **dropped** for this slice: the committed file serves the same purpose without adding a route.
- **Steps, each green before the next:**
  1. zod alignment, and schemas moved to contracts;
  2. `@Contract` and the generator, with the OA2 set comparison;
  3. response schemas, plus conformance in the tests (OA10, OA11);
  4. `api-client` and the web migration, the documents flow first (OA8);
  5. the CI gates (OA9, OA12).

## Decisions (owner, 2026-10-06)
| # | Decision | Conditions (in the criteria) |
|---|---|---|
| D1 | **Our own `@Contract` metadata + zod 4's JSON Schema output**, assembled from Nest's `DiscoveryService`. (`@nestjs/swagger` with `nestjs-zod` is not used.) | **OA1:** one zod version; an explicit target (OpenAPI 3.1.1, draft 2020-12). **OA3:** requests use `io: 'input'`; responses are described as serialized; unsupported conversions fail generation, never `{}`. |
| D2 | **`openapi-fetch` + `openapi-typescript`.** | **OA8:** cookies, CSRF, Problem Details, `If-Match` and download handling live in the shared wrapper. |
| D3 | **Schema validation in CI only**, not in the browser. | **OA8:** the existing handling of network failures and unexpected responses is preserved, and the browser's non-JSON gap is closed during the migration. |
| D4 | **Breaking-change detection is report-only.** | **OA12:** the diff is visible in the PR; intentional breaks are acknowledged in the PR description, with how older open tabs cope. |

## Docs to update in the same change
- **docs/06 §OpenAPI:**
  - the artifact's location;
  - the runtime endpoint dropped;
  - the target versions;
  - the extensions list;
  - schemas living in `packages/contracts`.
- **docs/02 §2 and the repo layout:** `packages/api-client` exists.
- **docs/12:** the contract layer (generation, conformance, the oasdiff report).
- **docs/13:** the PR description's "API breaking changes" section.
- **docs/17 §3:** the `@Contract` rule, and the lint rule with its storage-upload exception.
- **CLAUDE.md:** `pnpm contracts:gen` exists and is gated in CI.
- **README:** a status row.

## Implementation notes
### Step 1: zod aligned, request schemas in `packages/contracts` (2026-10-06)
- **One zod.** `pnpm-workspace.yaml` has a `catalog:` entry (`zod: 4.6.5`), and `apps/api` and `packages/contracts` both declare `"zod": "catalog:"`. The lockfile resolves exactly one `zod@4.6.5`.
  - `[OA1]` tests in `packages/contracts` fail if the lockfile resolves a second version, or if a package declares zod outside the catalog.
  - Both were mutation-checked: putting `^4.1.0` back in the API fails one; a second zod in the lockfile fails the other.
- **Request schemas moved, unchanged.** `packages/contracts/src/api/identity.ts` and `resources.ts` now hold every request body the controllers parse:
  - `CodeRequestBody` and `CodeConfirmBody` (activation and reset);
  - `LoginBody`, `StepUpBody`;
  - `MfaVerifyBody`, `MfaEnrolBody`, `MfaConfirmBody`;
  - `FileUploadRequestBody`, `ProductSetEnabledBody`, `SettingWriteBody`.

  No controller imports zod any more. The definitions are byte-for-byte the old ones, so behaviour is unchanged; unit tests cover strictness, the field rules and the either-or second factor. API integration: 303 passed, 1 opt-in skipped.
- **For step 2:**
  - **`SettingWriteBody.value` is `unknown`**, because each key validates its own value in the use case and returns `422 settings.invalid_value`. It converts to `{}`, which OA3 refuses. Step 2 must document the body per key without moving that check into the request schema, which would turn today's 422 into a 400.
  - **Path parameters** (`:id`, `:key`, `:product`) are not zod-validated today; the use cases check them. Step 2 declares their schemas for the document.

### Step 2: `@Contract` and the generator (2026-10-06)
- **Declarations.** `packages/contracts/src/api/operations.ts` holds one operation per route, grouped by module (`AuthOps`, `MfaOps`, `FilesOps`, …). Every handler carries `@Contract(<Group>.<op>)`, and the handlers that take a body parse it with that same operation's `body`.
  - A unit test reads each controller and fails if any `parse` call uses a schema other than its own `@Contract`'s.
- **The generator** (`apps/api/src/openapi/document.ts`) is pure. It reads the decorator metadata of `API_CONTROLLERS`, the list `AppModule.forRoot` serves.
  - **Access rules:** access kind, step-up and enrolment-only come from `routeAccess()`, which reads the guard's own metadata with the guard's precedence. Step-up uses the guard's `requiresStepUp` for catalog-flagged permissions.
  - **Tenant and product:** `@NoTenant` and `@Product`, read as the guards read them.
  - **No services needed:** nothing is instantiated, so `pnpm contracts:gen` runs without the database, Valkey or Vault.
  - **Where `DiscoveryService` comes in:** the integration test (below) compares the result with the routes the real app serves, using Nest's `DiscoveryService` cross-checked against Fastify's own registrations.
- **The document** is `packages/api-client/openapi.json`: OpenAPI 3.1.1, JSON Schema 2020-12, **30 operations**.
  - **Requests:** request bodies and path parameters. Response schemas, headers and errors come in step 3.
  - **Security:** schemes `session` and `mfaChallenge`; `x-no-tenant` on the health routes.
  - **Extensions:** `x-product`, `x-permission`, `x-step-up`, `x-allow-restricted`, `x-rate-limit`, `x-csrf` and `x-cookies`.
  - **`x-rate-limit` is declared in the contract,** because no decorator records rate limits; the use cases apply them.
- **Settings, one operation for all keys:**
  - **The `key` parameter** is an enum of the registry's keys.
  - **The body** keeps the strict envelope; `value` is an `anyOf` of one component per key (`SettingValue.<key>`), each converted from **that key's registry schema**, the object the use case validates with.
  - **`x-value-by-key`** maps each key to its value shape, because a body union alone can't say which value goes with which path key. **`x-permission-by-key`** lists each key's own manage permission and its step-up.
  - **The value check is unchanged:** it stays in the use case, so a wrong value is still `422 settings.invalid_value`.
  - **For step 4:** the typed client's settings helper carries the same key → value relationship, using `SettingValue<K>`.
- **Path parameters document today's checks, and add none:**

  | Parameter | What it's checked against | Invalid or unknown value |
  |---|---|---|
  | `files/{id}` | Must be a UUID (`format: uuid`) | `404 resource.not_found` |
  | `admin/products/{product}` | Enum of product keys | `404 resource.not_found` |
  | `settings/{key}` | Enum of setting keys | `404 settings.unknown_key` |

  - Each parameter states its 404 as `x-invalid`. Schemas are documentation only: nothing validates the path before the guards or the use case.
  - **What the tests prove, and which test:**
    - *The documented 404s:* called fully authorized, a malformed and an unknown value each get exactly the documented status and code.
    - *Authorization order:* the same values **without credentials** get `401 auth.unauthenticated`, never the 404. The 404 is only reachable after authorization.
- **zod's conversion drops refinements** (they don't become `{}`; they are simply absent). Each one is handled explicitly:
  - **Step-up's "code or recovery code, never both"** is expressible, so the schema states it: `not: { required: ["code", "recoveryCode"] }`, added with `.meta()` on the same zod object.
    - A test validates the **documented** schema with Ajv (2020-12) and the runtime zod validator on the same cases, and they must agree:
      - password alone is accepted, for non-MFA users;
      - password with a code, or with a recovery code, is accepted;
      - both is refused;
      - no password is refused.
    - The API's response is unchanged and pinned: both credentials is `400 request.invalid`.
  - **MFA verify needs exactly one credential.** That is already in the schema: an `anyOf` of two strict objects, so `{}` and both are refused. The same agreement test covers it. A new integration test shows both, or neither, is `400 request.invalid` and spends nothing: the same challenge and recovery code still work afterwards.
  - **Unit limits' `min ≤ max`** can't be expressed in JSON Schema, which can't compare two fields. The value schema's `description` states it as a runtime rule, with its `422 settings.invalid_value`.
- **Tests:**

  | Kind | What they cover |
  |---|---|
  | 24 unit (`openapi/document.spec.ts`) | target versions; the committed file equals a fresh build (stale check); route sets; the named control routes; refusing a route without a contract, a parameter mismatch, an unrepresentable schema and an empty schema (with its JSON pointer); bodies equal their validators; strict bodies; the second-factor rules (Ajv on the document agrees with zod); the `min ≤ max` runtime rule stated; the settings key → value tie and per-key permissions; security; step-up; enrolment-only; tenantless health; CSRF on exactly the unsafe operations |
  | 18 integration (route sweep) | the routes the app serves minus `CONTROL_ROUTES` equal the document's; every documented parameterised route has a caller; for all 8 such routes, invalid and unknown values get the documented 404 when fully authorized, and 401 without credentials |
  | 2 integration (identity) | MFA verify with both or neither credential is `400 request.invalid` and spends nothing (new); step-up with both pins `400 request.invalid` (existing test, now asserting the code) |
- **Mutations caught (8):**
  - a handler without `@Contract` (generation refused, naming the route);
  - a body changed without regenerating;
  - `@AllowRestricted` removed from logout;
  - a controller parsing with another operation's schema;
  - a malformed file id answered 400 instead of 404;
  - `@RequireStepUp` removed from TOTP disable;
  - the step-up `not` clause removed (the document would allow both credentials);
  - `GET /files/:id` skipping authorization (its 404 reachable without credentials).
- **Found while building:**
  - **The empty-schema check was too narrow.** It recognised only type-like keywords, so it flagged `not: { required: [...] }` as empty. It now recognises JSON Schema's assertion keywords; `{}`, and schemas carrying only `title` or `description`, are still refused.
  - **The generator crashed on a parameter mismatch.** It threw a `TypeError` instead of reporting the problem; a negative-control test found it, and it now reports and continues.
  - **`GET /admin/products` requires step-up.** Its permission, `settings.product.manage`, is step-up-flagged, so the document says so and the web app wraps the call in `withStepUp`.
- **The stale check runs from now on.** OA9's comparison of the committed file with a fresh build is already a unit test, so CI fails on a stale `openapi.json` from this step. The separate `git diff` gate on the generated client types comes with step 5.

### Step 3: responses, errors and conformance (2026-10-06)
- **How the schemas were written: from real traffic.** The conformance hook has a record mode (`UNIVARSE_OA_RECORD`). One run of the integration suite captured all 1,299 responses, covering all 30 operations, and the response schemas were written from those, not guessed. Strict checking was switched on afterwards.
- **Responses.** `packages/contracts/src/api/responses.ts` describes each success body as it is **serialized**: ids and timestamps are strings, and 204 has no content.
  - Every schema is strict, so a renamed or extra field fails.
  - Each operation declares `response`, or `binary` (the download's PDF, PNG or JPEG), plus `etag`, `ifMatch` and its own use-case `errors`.
  - **Settings responses tie key to value exactly:** one variant per registry key, with `key` as a literal and `value`/`default` from that key's schema. Here the key is in the body, so JSON Schema can express the tie directly.
- **Errors.** Every error response is `application/problem+json`, using the shared `Problem` component (strict) narrowed to its `status` and an enum of its codes.
  - **The generator derives the route-level errors from the guards' metadata:**

    | Source | Errors |
    |---|---|
    | Tenant | 404, 423 |
    | Product off | 404 (for non-core products) |
    | Authentication | 401 |
    | Enrolment-only session | 403, unless the route allows it |
    | Permission | 403 forbidden; also `mfa_required` when the permission is privileged |
    | Step-up | 428, including through settings' per-key manage permissions |
    | Validation | 400 |
    | CSRF | 403 |
    | Rate limit | 429, with `Retry-After` |
    | Path parameters | their documented 404 |
    | `If-Match` | 428, 412 |
    | Anything | `500 server.internal` |

  - **Each contract adds only its use-case codes.** These were taken from the codes each service method throws, not just the ones tests happened to hit. For example, `500 settings.stored_value_invalid` is now documented for settings reads and writes.
  - **Every 500 the suite saw was deliberate:** audit-write failure injection for settings and products, and the tampered-file test.
- **Headers:**
  - **Settings:** `ETag` on settings responses; `If-Match` is a documented, required header parameter on writes.
  - **Cookies:** `Set-Cookie` on the six operations that set or clear cookies, with `x-set-cookie` naming which cookies.
  - **Rate limits:** `Retry-After` on 429.
  - **Download:** `Content-Disposition`, `Content-Length`, `X-Content-Type-Options`, the sandbox CSP and `Cache-Control`.
- **Conformance (OA10).** `apps/api/src/testing/conformance.ts` wraps `fastify.inject` on every integration test app: the harness, the route sweep, and the app and auth tests. It checks each response **as sent**:
  - the status is documented;
  - the media type is documented;
  - the raw payload parses and validates against its schema (Ajv 2020, strict);
  - the documented headers are present and match;
  - only documented cookies are set, each with `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age`, and cleared cookies have `Max-Age=0`;
  - a Problem's `type` is `problemType(code)`;
  - a binary response's `Content-Length` equals the payload bytes;
  - a 204 has an empty body.

  **One app is excluded, deliberately:** the settings tests' second app serves a test-only registry the document doesn't describe.
- **Coverage line (partial coverage, by design of what it measures),** printed by the global teardown: `[openapi-conformance] operations 30 of 30; (operation, status) pairs seen 141 of 207; responses checked 1293`, followed by every documented pair never exercised. The 66 gaps are mostly 500s (27) and tenant-level 404s (19) on routes the suite doesn't drive into those states. They are listed, not hidden.
  - **What this does not show:** 141/207 counts (operation, status) pairs. It does **not** establish that every error code, or every response variant within a status, was exercised. For example, it doesn't show both login outcomes, every 403 code, or every setting key's value shape.
- **Negative controls (OA11):**
  - **18 unit tests** feed the checker wrong responses and correct ones:
    - a renamed field;
    - an undocumented status;
    - an undocumented error code;
    - a wrong Problem `type`;
    - a 204 with a body;
    - a `Content-Length` mismatch;
    - an undocumented binary type;
    - a missing `nosniff`;
    - an `inline` disposition;
    - a missing `ETag`;
    - a value that doesn't fit its key;
    - a cookie without `HttpOnly`;
    - an undocumented cookie;
    - a 429 without `Retry-After`.
  - **6 mutations of the real app,** all caught by name in the integration suite:
    - a renamed response field;
    - an undocumented 202;
    - an error code dropped from the contract;
    - a wrong Problem `type`;
    - the session cookie without `HttpOnly`;
    - a settings read without `ETag`. This one fires in the route sweep's setup, so it fails the file rather than one named test.
- **Found by the new tests:**
  - **`request.csrf_rejected` had no user message,** so a CSRF refusal would have shown the browser the generic fallback. A test now requires a message for every documented error code, and the message has been added.
  - **The CSRF claim in this spec was wrong** (corrected above).
- **Tests:**

  | Suite | Result |
  |---|---|
  | API unit | 116 (generator 35, checker 18) |
  | API integration | 322 passed, 1 opt-in skipped, every response checked |

### Step 4: the generated client, used by the whole web app (2026-10-06)
- **`packages/api-client`:**
  - **Types:** `src/schema.ts`, generated by `openapi-typescript` from `openapi.json`. It's a `.ts` file, not `.d.ts`, so it compiles into `dist`. A `.d.ts` file isn't copied, and every type collapsed to `never`.
  - **Wrapper:** a thin `openapi-fetch` wrapper (`src/client.ts`) holds everything the call sites share:

    | Behaviour | How the wrapper handles it |
    |---|---|
    | Failures | No answer is `ApiError(0, 'network.offline')`. A non-JSON answer (a proxy's 502 page) or a truncated JSON body is `ApiError(status, 'server.unexpected_response', <x-request-id>)`, never a raw `SyntaxError`; this closes the browser gap recorded in step 1. |
    | 204 and binary | 204 and empty bodies are never parsed. The download is a link built by `contentUrl(id)` from the documented path, which is checked at compile time. |
    | Problem Details | Become `ApiError(status, code, requestId, fieldErrors)`. The request id comes from the body, or the `x-request-id` header if the body has none; the message is chosen by code. |
    | `unwrap()` | Returns the data or throws, for browser components. |
    | `answer()` | Returns `{ status, body, data, requestId }` for Server Components, where a non-JSON answer keeps its status with a null body and only a network failure throws. This preserves the session check (spec 0005 W7). |
    | Settings | `getSetting`, `putSetting`, `resetSetting` (`src/settings.ts`): the key picks `SettingValue<K>`, the response narrows to that key's variant (`SettingViewOf<K>`), writes send `If-Match`, and every call returns the ETag from the response. |

- **Tests (14):**
  - `client.spec.ts` (13), with `vitest --typecheck`, covers each row above;
  - type-level assertions that login's type includes both outcomes (an MFA challenge or a session), and that each setting key's value type is exact;
  - `schema.spec.ts` regenerates the types in memory and fails if `schema.ts` is stale. It was mutation-checked: an edited `schema.ts` fails.
- **The web app:**
  - **Browser calls:** `lib/client-api.ts` is now a `createApi({ baseUrl: '', credentials: 'same-origin' })` instance; the browser sends cookies, including rotated ones, and same-origin `Sec-Fetch-Site`.
  - **Server calls:** `lib/server-api.ts` keeps the forwarding transport (Host, X-Forwarded-*, cookie, user agent). It exposes `serverGet(api => api.GET(...))`, typed GET-only, so there is no CSRF surface on the server.
  - **Removed:** the hand-typed `api()` and `serverApi()`, and every hand-written response type.
  - **Migration order:** the documents page first (JSON, direct storage upload, binary download), then every other call site, 25 in all:
    - **Client:** login, MFA verify, MFA setup, step-up, logout, activation and reset, products, settings.
    - **Server:** session, tenant profile, workspace layout and home, products, settings, users, documents.
  - **Step-up** still wraps typed calls through `useStepUp`, because `ApiError` (`auth.step_up_required`) is unchanged.
  - **The settings card** now sends the ETag the API returned, including after a 412 reload, instead of one rebuilt from `version`.
- **The generated types removed dead cases:**
  - `FileView` no longer lists `DELETED`/`ABANDONED`, which the API never returns;
  - `ProductState.product` is the product enum, not `string`;
  - the users page's status labels are now total, so its fallback was dead code and is gone.
- **Lint (OA8),** in `eslint.config.mjs`, for `apps/web/src`:
  - **Forbidden:** `fetch`, `XMLHttpRequest`, `window`/`globalThis.fetch`, and any `/api/v1/` string or template.
  - **Allowed:** the typed client's path argument and type positions.
  - **Named exceptions:** `lib/server-api.ts` (transport) and `lib/storage-upload.ts`, the presigned POST to storage, which is not an API call.
  - **Proven:** a probe file with all five kinds of violation fails, and the migrated code passes.
- **`pnpm contracts:gen`** now regenerates `openapi.json` and `schema.ts` together.
- **New user message:** `server.unexpected_response`.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Event (outbox) schema contracts and compatibility checks | With the first cross-product event consumer |
| Publishing the API docs (rendered reference), or serving `openapi.json` | When an external integrator exists |
| Runtime response validation in the client (D3) | If CI conformance ever misses a real bug |
| Blocking breaking changes (D4) | When a client we don't deploy ourselves exists (mobile, third parties) |
| Cross-instance product cache (spec 0003 P7), key-forget broadcast and shred ledger (spec 0006) | Unchanged: on the invalidation bus and the staging backups. File isolation alone does not close layer 5 |
