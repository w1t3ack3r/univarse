# 06 — API Guidelines

Applies to every HTTP endpoint in `apps/api`. Contracts live in `packages/contracts`, and the OpenAPI document is generated from them.

## 1. Basics

- **Style:** resource-oriented REST over HTTPS, JSON (`application/json; charset=utf-8`).
- **Base paths:**
  - Tenant API: `https://{tenant-host}/api/v1/...` (tenant from Host)
  - Platform API: `https://console.univarse.ng/api/platform/v1/...`
  - Webhooks: `https://api.univarse.ng/webhooks/{gateway}/{tenantWebhookId}`, a dedicated host with no cookies, where the tenant is resolved from the path ID
  - Public verification: `https://{tenant-host}/api/v1/public/verify/{code}`
- **Versioning:** major version in the path. Additive changes don't bump it. Breaking changes need `/v2` for the affected resources, with a ≥ 6-month deprecation window (`Deprecation` + `Sunset` headers).
- **Naming:** plural kebab-case nouns (`/course-offerings`), camelCase JSON fields, IDs as strings (UUIDv7).
- **Nesting** at most one level deep, where ownership is real: `/score-sheets/{id}/entries`.
- **Actions** that aren't CRUD are sub-resources with verbs: `POST /score-sheets/{id}/submit`, `/approve`, `/return`, `/publish`. Each maps to one state-machine transition.

## 2. Requests

- Every body is validated by its zod schema (`nestjs-zod` pipe). Unknown fields are **rejected** (`strict()`), which prevents mass assignment.
- `tenantId`, `createdBy` and similar are **never accepted from the client**. They come from context.
- Dates: ISO-8601 strings. Date-only (`2026-03-15`) for calendar dates, full UTC timestamp (`2026-03-15T22:59:59Z`) for instants.
- Money: integer **kobo** in fields named `...Kobo` (`amountKobo: 15000000`).
- Scores and GPAs: strings with fixed decimals (`"3.46"`) to avoid float drift in clients.
- Enums: `SCREAMING_SNAKE_CASE` strings.

## 3. Responses

- Single resource: the object itself. Collections:
```json
{
  "data": [ ... ],
  "page": { "nextCursor": "eyJpZCI6...", "limit": 50, "hasMore": true },
  "meta": { "total": 1234 }        // only when cheap/needed
}
```
- **Pagination:** cursor-based by default (`?cursor=&limit=`, max 200). Offset pagination is allowed only for small admin tables with a known size.
- **Filtering/sorting:** `?status=SUBMITTED&level=300&sort=-createdAt&q=adeyemi`. Only allow-listed fields.
- **Response DTOs** are explicit mappers. Never serialize ORM objects, because hidden fields (password hashes, encrypted secrets) must be impossible to leak by accident.
- `201 Created` + `Location` header for creates. `202 Accepted` + a job resource for async work. `204` for deletes.

## 4. Errors — RFC 9457 Problem Details

```json
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://docs.univarse.ng/errors/registration.max-units-exceeded",
  "title": "Maximum units exceeded",
  "status": 422,
  "code": "registration.max_units_exceeded",
  "detail": "Selected courses total 27 units; maximum is 24.",
  "requestId": "01J9Z...",
  "errors": [ { "path": "items", "code": "max_units", "message": "..." } ]
}
```

| Status | Use |
|--------|-----|
| 400 | Malformed request / validation failure (`errors[]` populated) |
| 401 | Not authenticated / session expired. The only status clients treat as "signed out" |
| 403 | Authenticated but not permitted (**don't** reveal whether the resource exists across scopes. Use 404 for out-of-scope resources) |
| 404 | Not found **or not visible to you** |
| 409 | State conflict (wrong state for transition, duplicate) |
| 412 | `If-Match` version mismatch (optimistic lock) |
| 422 | Business rule violation (domain error codes) |
| 423 | Tenant suspended / resource locked |
| 428 | Step-up authentication required (`code: auth.step_up_required`) |
| 429 | Rate limited (`Retry-After`) |
| 500/503 | Unexpected / dependency down. Never leak stack traces or SQL |

Every API response carries the request id in the `x-request-id` header, so a client can still show the support reference when the body is not problem+json.

Error `code`s are stable, namespaced and listed in `packages/contracts/errors.ts`. The UI maps codes to messages. It never parses `detail`.

## 5. Concurrency & idempotency

- Mutable resources that people edit concurrently (score sheets, fee schedules, settings, curriculum drafts) return `ETag: "v{version}"`. Updates **must** send `If-Match`, or the server returns 428/412.
- `Idempotency-Key` header (UUID) is **required** on: payment initiation, manual payments, imports commit, invoice generation, publication, enrolment, and any bulk action. Keys are stored for 24h per (tenant, user, route). A replay returns the original response.
- Webhook handlers are idempotent by `(gateway, eventId/reference)`.

## 6. Authorization in endpoints

- Every controller method declares its permission: `@RequirePermission('results.scoresheet.approve_hod')`.
- The **resource-scope check** happens in the use case (it needs the loaded resource): `policy.assert(actor, 'results.scoresheet.approve_hod', sheet.orgPath)`.
- Sensitive actions add `@RequireStepUp()`.
- List endpoints **filter by scope in the query**. They never filter after loading.

## 7. Rate limiting

| Category | Default limit (per key) | Key |
|----------|------------------------|-----|
| `auth` (login, OTP, reset) | 5/min, 20/hour | IP + username |
| `otp-send` | 3 per 15 min | user/phone |
| `public-verify` | 30/min | IP |
| `read` | 300/min | session |
| `write` | 60/min | session |
| `export/import` | 10/hour | user |
| `webhook` | 600/min | gateway + tenant |

Returned as `RateLimit-*` headers (IETF draft) and `429` with `Retry-After`.

## 8. Long-running work

```
POST /api/v1/imports            → 202 { "jobId": "...", "status": "VALIDATING" }
GET  /api/v1/jobs/{jobId}       → { status, progress: 0.42, resultUrl?, errorReportUrl? }
GET  /api/v1/jobs/{jobId}/events  (SSE, optional)
```

## 9. Files

- Upload: `POST /files/uploads` → returns a **presigned PUT URL** + `fileId` (size/type limits embedded) → client uploads directly to storage → `POST /files/{id}/complete` → async scan → the file is usable only when `scanStatus=CLEAN`.
- Download: `GET /files/{id}/download` → authorization check → `302` to a presigned GET URL (TTL ≤ 5 min, `Content-Disposition: attachment` for user content).

## 10. Documentation & client generation

- OpenAPI 3.1 is generated at build time (`/api/v1/openapi.json` in non-prod only). It's published in the repo as an artifact.
- `packages/api-client` is generated from OpenAPI (e.g. `openapi-typescript` + a thin fetch wrapper). The web app **must** use it. Hand-written fetch calls to the API aren't allowed.
- Each endpoint's OpenAPI entry includes: permission, step-up flag, idempotency requirement, rate-limit category, error codes.

## 11. Webhooks (inbound)

1. Dedicated host and route per gateway + tenant webhook ID.
2. **Verify the signature** over the raw body (Paystack HMAC-SHA512 of the body with the secret; Flutterwave `verif-hash` / signature; Remita per their spec `[VERIFY]`). Reject otherwise (401) and log a security event.
3. Optional source-IP allowlist where the provider publishes IPs.
4. Persist the raw event (hash + minimal payload), enqueue, return `200` fast.
5. The processor **re-verifies with the gateway API** (verify-transaction) before crediting.

## 12. Outbound webhooks (later, for integrations)

Signed (HMAC-SHA256, timestamped), retries with exponential backoff, a delivery log, and per-tenant endpoints. `[PHASE 7+]`
