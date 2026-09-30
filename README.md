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
| Activation → login → /me → logout | ✅ | ✅ | ✅ | ✅ HTTP on `*.localhost` · ❌ HTTPS not yet |
| Existing sessions blocked on disable / lock / role removal / suspension | ✅ | ✅ | ✅ | — |
| Rate limits not bypassable via forwarding headers | ✅ | ✅ mutation-checked | ✅ | — |
| CSRF (Fetch Metadata / Origin) | ✅ | ✅ | ✅ | ✅ same-origin path only |
| Password reset (spec 0001 R1–R11) | ✅ | ✅ 14 tests, 3 mutations caught | ✅ (#3) | — |
| TOTP MFA (M1–M10), step-up (S1–S5) | ❌ next | — | — | — |

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
