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
| Reset flow in a real browser (dev edge, HTTP) | ❌ harness has no reset form yet | — | — | ❌ |
| TOTP MFA (M2–M15 incl. R16) | ✅ | ✅ 24 tests + 24 unit; layered mutation-checked | ✅ (#6) | ❌ harness has no MFA flow yet |
| M1 secret at rest | 🟡 **direct AES-GCM, single key, AAD-bound. NOT envelope** (ADR-018 deviation) | ✅ | ⏳ | n/a |
| Envelope encryption (KMS-wrapped per-tenant DEKs; covers MFA secrets and outbox payloads) | ❌ required before staging (ADR-018) | — | — | — |
| MFA tables live isolation (app role) | ✅ | ✅ 6 tests; disabling RLS fails 4 | ⏳ | n/a |
| All-table generic isolation sweep | ❌ Phase 0 task | — | — | — |
| Step-up (S1–S12) + MFA management (M9a–M9e, M15′) | ✅ | ✅ 30 tests + 13 guard unit; mutation-checked | ✅ (#7) | ❌ harness has no step-up flow yet |
| Permission-flagged step-up on a real route (S9) | ✅ `PUT /admin/products/{product}` (`settings.product.manage`) | ✅ 428 without step-up | ⏳ PR | — |
| Hash-chained audit log + identity events (spec 0002 Part A) | ✅ | ✅ 19 tests + 5 unit; 6/6 mutations caught | ✅ (#8) | n/a |
| Product entitlements + product guard (spec 0003 P1–P9) | ✅ | ✅ 16 tests + 9 unit; 8/8 mutations caught | ⏳ PR | n/a (no UI yet) |
| Inactive product → 404 through a real non-core route (P3 end-to-end) | 🟡 guard unit-tested + guard order asserted; no non-core route yet | — | — | — |
| Cross-instance product/tenant cache invalidation (P7) | ❌ before multi-instance production | — | — | — |
| Audit chain anchoring outside the DB (A5 limit) | ❌ before GA | — | — | — |
| Outbox + worker + durable email (spec 0002 Part B B1–B10, R15a) | ✅ | ✅ 12 tests + 5 unit; 10/10 mutations caught; end to end via Mailpit | ⏳ PR | n/a |
| Timestamps as true instants on non-UTC servers (UTC sessions) | ✅ | ✅ 2 tests; fails without the fix | ⏳ PR (CI Postgres in Africa/Lagos) | n/a |

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
pnpm db:seed       # demo-uni, test-poly, paused-uni (suspended)
pnpm dev:secrets && pnpm dev:infra   # Valkey + Mailpit (Docker; UI http://127.0.0.1:8025)
pnpm rls:check     # static tenant-isolation gate
pnpm test          # unit tests
pnpm --filter @univarse/db test:int   # cross-tenant isolation tests against the real DB
```

Browser check without the web app: start `api` and `edge-demo-uni` from `.claude/launch.json` (or `node tools/dev-edge/start-api.mjs` + `node tools/dev-edge/server.mjs`) and open http://demo-uni.univarse.localhost:4180.

Use `PGPORT=5433 pnpm db:setup` if your PostgreSQL 18 runs on another port.

`pnpm dev` runs the outbox worker next to the API, so activation and reset codes arrive in Mailpit. Requests never send email themselves (spec 0002 B7).

**Local databases from before 2026-10-05 on a non-UTC server** (for example Windows set to West Africa Time) hold timestamps shifted by the server offset, so their audit chains don't verify ([spec 0002 notes](docs/specs/0002-audit-and-outbox.md)). Reset the tenant database once: drop `univarse_pool_01` as the postgres superuser, then run `pnpm db:setup && pnpm db:migrate && pnpm db:seed`.
