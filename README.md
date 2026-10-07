# UniVarse

[![ci](https://github.com/w1t3ack3r/univarse/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/w1t3ack3r/univarse/actions/workflows/ci.yml)

Multi-tenant platform for Nigerian tertiary institutions: admissions, fees, course registration, examinations, results (HOD → Dean → Senate), GPA/CGPA, clearance, graduation, transcripts and hostels.

**Start with the blueprint:** [docs/README.md](docs/README.md).

## Status

Rebuilding from scratch (see [ADR-013](docs/19-decision-log.md)). The earlier prototype is preserved at git tag `v0-prototype`.
Current phase: **Phase 0 — Foundations** ([roadmap](docs/18-roadmap.md)).

### Verification status

Statuses are kept distinct: **implemented** → **tested locally** → **verified in CI** / **verified in browser**.

| Capability | Implemented | Tested locally | Verified in CI | Verified in browser |
|---|---|---|---|---|
| Grading / GPA engine (`packages/domain`) | ✅ | ✅ 41 tests, 100% lines | ✅ | n/a |
| Tenant DB isolation (forced RLS, composite FKs, RLS gate) | ✅ | ✅ 8 tests + checker negative control | ✅ | n/a |
| Host → tenant resolution, suspended → 423 | ✅ | ✅ | ✅ | ✅ via dev edge |
| Activation → login → /me → logout | ✅ | ✅ | ✅ | ✅ HTTP on `*.localhost` |
| **HTTPS: cookies + proxy config on deployed staging** | — | — | — | ❌ blocked: no staging yet |
| Existing sessions blocked on disable / lock / role removal / suspension | ✅ | ✅ | ✅ | — |
| Rate limits not bypassable via forwarding headers | ✅ | ✅ mutation-checked | ✅ | — |
| CSRF (Fetch Metadata / Origin) | ✅ | ✅ | ✅ | ✅ same-origin path only |
| Password reset (spec 0001 R1–R11) | ✅ | ✅ 14 tests, 3 mutations caught | ✅ (#3) | — |
| Reset hardening R12–R15 (concurrency, eligibility, timing) | ✅ | ✅ 6 tests, R12/R13/R15 mutation-checked; R15 floors asserted (2026-10-05) | ✅ | — |
| Web app skeleton + brand tokens + login / MFA verify / workspace (spec 0005 PR A) | ✅ | ✅ 10 unit; 9 E2E journeys × desktop + mobile (Edge); logout mutation caught | ✅ (#14, Chromium) | ✅ HTTP on `*.localhost` via the edge (screenshots in PR) |
| Login + TOTP + recovery-code login in a real browser | ✅ | ✅ E2E | ✅ (#14) | ✅ HTTP (closes that part of the spec 0001 gap) |
| Activation, reset, two-step setup and step-up in a real browser (spec 0005 PR B, W11–W15) | ✅ | ✅ 5 journeys × desktop + mobile; codes read from Mailpit | ✅ (#17) | ✅ HTTP via the edge (closes the spec 0001 browser gap over HTTP) |
| TOTP MFA (M2–M15 incl. R16) | ✅ | ✅ 24 tests + 24 unit; layered mutation-checked | ✅ (#6) | ✅ verify + enrolment (spec 0005) |
| M1 secret at rest | ✅ envelope `v2` under the tenant's own DEK (spec 0006); `v1` values migrate with `keys migrate-v1` | ✅ cross-tenant decrypt fails (mutation-checked) | ✅ (#18) | n/a |
| Envelope encryption, PR A (spec 0006 E1–E6, E10–E12): per-tenant DEKs wrapped by Vault Transit; MFA secrets + outbox payloads | ✅ | ✅ 14 unit + 10 against real Vault; 5 mutations caught; E2E 28 via Vault | ✅ (#18) | n/a |
| Envelope encryption, PR B (E7–E9: DEK rotation + sweep, KEK re-wrap, v1 → v2 migration, `keys` CLI) | ✅ | ✅ 12 tests against real Vault, scratch tenants; 8 mutations caught; run on local data | ✅ (#21) | n/a |
| Tenant settings, one typed key end to end (spec 0007 ST1–ST13): `registration.unitLimits`, Registrar-managed, step-up, `If-Match`, audited | ✅ | ✅ 22 integration + 3 registry unit; 7 mutations caught | ✅ (#24) | ✅ Settings page, desktop + mobile (E2E, screenshots reviewed) |
| Settings cache: tenant-scoped keys, ≤ 2 s cross-instance, ≤ 30 s if a message is lost, no stale re-cache, works without Valkey (ST10–ST11) | ✅ | ✅ two API instances, measured (tests ST10, ST11a–d); mutations caught | ✅ (#24, two-instance tests in CI) | n/a |
| Registration **enforcing** the unit limits | ❌ Phase 4 (registration module); mid-window change semantics to be decided first | — | — | — |
| MFA tables live isolation (app role) | ✅ | ✅ 6 tests; disabling RLS fails 4 | ✅ (every CI run) | n/a |
| All-table generic isolation sweep (spec 0004 I1–I9) | ✅ every tenant table, discovered from the catalog | ✅ 9 tests × 14 tables; 3 negative controls fail it | ✅ (#13) | n/a |
| API route sweep, isolation layer 3 (spec 0009 RS0–RS9): **complete for today's routes** | ✅ routes discovered from `onRoute` and cross-checked against Nest; **real resource-by-id routes: 4** (`GET`, `DELETE /files/:id`, `POST /files/:id/complete`, `GET /files/:id/content`, spec 0010) | ✅ RS6 on all 4: B's id and another user's id answer exactly like a nonexistent id, and neither file changes. Plus 2 synthetic leaks detected, the production build free of test routes, legitimate operations first. Counts are in the CI log's `[route-sweep]` line | ✅ (#25) for the first 24 routes; the 4 file routes are ⏳ in the file-uploads PR | n/a |
| OpenAPI contract + generated api-client (spec 0011 OA1–OA12): 30 operations from route metadata, every error documented, web app on the client | ✅ generated from `@Contract` + guard metadata; settings key → value tied; lint bans hand-written API calls | ✅ real-response conformance on every integration response (30/30 operations; 141/207 operation-status pairs, partial); 8 + 6 mutations caught; CI regenerates and diffs; oasdiff breaking changes must be acknowledged | ✅ (#28–#34); `api-breaking-changes` required | ✅ every page (E2E 32/32 in CI and locally) |
| File uploads, first slice (spec 0010 FU1–FU18): upload → scan → authorised download → delete, against real SeaweedFS + ClamAV | ✅ presigned POST (D1 decided by a contract test), fail-closed ClamAV, verified downloads, atomic quota, deletion wins, lease-unique clean keys | ✅ 27 integration + 7 storage-contract tests, E2E desktop + mobile; 7 mutations caught; peak memory measured in 3 runs (docs/10 §4.1); FU3 limit/encryption and FU18 takeover results in spec 0010's completion record | ✅ (#26) | ✅ "My documents" page (E2E, screenshots reviewed) |
| Observability, first slice (spec 0012 OB1–OB12, **in progress**): JSON logs + OpenTelemetry traces for the API and worker; request → outbox/scan propagation; bounded export | ✅ Pino logger + Nest adapter, redaction and scrubbing; traces sanitized in-process; `traceparent` on outbox and file rows; export gate with counted drops and a 5 s shutdown deadline | ✅ logs, leak test (OB6), context isolation (OB8, requests + worker pass), propagation (OB10), failing collectors (OB11); mutation-checked; compiled API + worker against a real collector (OB12) | ✅ logs and API traces (#38, #39); 🟡 OB10–OB12 pending PR | n/a (local E2E: cause measured, clean local run pending) |
| Step-up (S1–S12) + MFA management (M9a–M9e, M15′) | ✅ | ✅ 30 tests + 13 guard unit; mutation-checked | ✅ (#7) | ✅ step-up dialog on the Products page (spec 0005 PR B) |
| Permission-flagged step-up on a real route (S9) | ✅ `PUT /admin/products/{product}` (`settings.product.manage`) | ✅ 428 without step-up | ✅ (#10) | — |
| Hash-chained audit log + identity events (spec 0002 Part A) | ✅ | ✅ 19 tests + 5 unit; 6/6 mutations caught | ✅ (#8) | n/a |
| Product entitlements + product guard (spec 0003 P1–P9) | ✅ | ✅ 16 tests + 9 unit; 8/8 mutations caught | ✅ (#10) | n/a (no UI yet) |
| Inactive product → 404 through a real non-core route (P3 end-to-end) | 🟡 guard unit-tested + guard order asserted; no non-core route yet | — | — | — |
| Cross-instance product/tenant cache invalidation (P7) | ❌ before multi-instance production | — | — | — |
| Cross-instance key "forget" on shredding (spec 0006): cached DEKs dropped in seconds, not ≤ 1 h | ❌ with the settings invalidation bus | — | — | — |
| Shred ledger outside the platform DB + restore runbook that re-applies it (spec 0006) | ❌ staging, before any real-like data | — | — | — |
| Audit chain anchoring outside the DB (A5 limit) | ❌ before GA | — | — | — |
| Outbox + worker + durable email (spec 0002 Part B B1–B10, R15a) | ✅ | ✅ 12 tests + 5 unit; 10/10 mutations caught; end to end via Mailpit | ✅ (#12) | n/a |
| Timestamps as true instants on non-UTC servers (UTC sessions) | ✅ | ✅ 2 tests; fails without the fix | ✅ (#12, CI Postgres in Africa/Lagos) | n/a |

Isolation-layer coverage and known gaps: [docs/12 §3.1](docs/12-testing-strategy.md).

## Prerequisites

- Node.js 24 LTS, pnpm 10 (`npm i -g pnpm@10`)
- PostgreSQL **18** running locally (default `127.0.0.1:5432`)

## Getting started

```bash
pnpm install
pnpm db:setup      # asks for your local postgres superuser password (hidden), creates
                   # least-privilege roles + databases, writes .env (git-ignored)
pnpm db:migrate    # platform + tenant migrations (RLS, grants)
pnpm dev:secrets && pnpm dev:infra   # Valkey, Mailpit (UI http://127.0.0.1:8025), Vault, SeaweedFS (S3), ClamAV (Docker; give Docker ≥ 4 GB, docs/10 §4.1)
pnpm db:seed       # demo-uni, test-poly, paused-uni (suspended) + each tenant's data key (needs Vault)
pnpm rls:check     # static tenant-isolation gate
pnpm test          # unit tests
pnpm --filter @univarse/db test:int   # cross-tenant isolation tests against the real DB
```

**Web app:** start `api`, `web` and `edge-demo-uni` from `.claude/launch.json` (or `node tools/dev-edge/start-api.mjs`, `pnpm --filter @univarse/web dev`, `node tools/dev-edge/server.mjs`) and open http://demo-uni.univarse.localhost:4180. The edge sends `/api/*` to the API and everything else to the web app, as production does. E2E: `pnpm build && pnpm test:e2e`.

Use `PGPORT=5433 pnpm db:setup` if your PostgreSQL 18 runs on another port.

**Vault (spec 0006):** `pnpm dev:infra` also initialises and unseals a local Vault and writes a least-privilege `VAULT_TOKEN` to `.env`. Its unseal key and root token stay in the git-ignored `.vault-dev.json`; deleting that file means resetting the `univarse-dev_vault-data` volume and re-seeding. After a Docker restart, `pnpm dev:vault` unseals it again. Key operations (rotate, sweep, v1 migration, retired-key destroy, KEK re-wrap): `pnpm --filter @univarse/api build && pnpm --filter @univarse/api keys status` (see `apps/api/src/cli/keys.ts`).

**Traces (spec 0012, optional):** `pnpm dev:traces` starts a local OpenTelemetry Collector that writes spans to `infra/compose/otel/out/traces.jsonl`; `pnpm dev:traces:jaeger` adds Jaeger's UI on http://127.0.0.1:16686. Then run the API and worker with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318`. With no endpoint set, nothing is exported. Stop the collector and Jaeger when you're done; on an 8 GB machine memory matters (docs/10 §4).

`pnpm dev` runs the outbox worker next to the API, so activation and reset codes arrive in Mailpit. Requests never send email themselves (spec 0002 B7).

**Local databases from before 2026-10-05 on a non-UTC server** (for example Windows set to West Africa Time) hold timestamps shifted by the server offset, so their audit chains don't verify ([spec 0002 notes](docs/specs/0002-audit-and-outbox.md)). Reset the tenant database once: drop `univarse_pool_01` as the postgres superuser, then run `pnpm db:setup && pnpm db:migrate && pnpm db:seed`.
