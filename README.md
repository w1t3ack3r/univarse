# UniVarse

Multi-tenant platform for Nigerian tertiary institutions: admissions, fees, course registration, examinations, results (HOD → Dean → Senate), GPA/CGPA, clearance, graduation, transcripts and hostels.

**Start with the blueprint:** [docs/README.md](docs/README.md).

## Status

Rebuilding from scratch (see [ADR-013](docs/19-decision-log.md)). The earlier prototype is preserved at git tag `v0-prototype`.
Current phase: **Phase 0 — Foundations** ([roadmap](docs/18-roadmap.md)).

| Package | What | State |
|---------|------|-------|
| `packages/domain` | Pure grading / GPA / CGPA / standing / classification engine | ✅ 41 tests, 100% line coverage |
| `packages/db` | Platform + tenant Prisma schemas, forced RLS, composite tenant FKs, RLS checker, isolation tests | ✅ migrated; RLS gate + 8 isolation tests green |
| `apps/api` | NestJS (Fastify) API | ⏳ next |
| `apps/web`, `apps/console` | Next.js apps | ⏳ |

## Prerequisites

- Node.js 24 LTS, pnpm 10 (`npm i -g pnpm@10`)
- PostgreSQL **18** running locally (default `127.0.0.1:5432`)

## Getting started

```bash
pnpm install
pnpm db:setup      # asks for your local postgres superuser password (hidden), creates
                   # least-privilege roles + databases, writes .env (git-ignored)
pnpm db:migrate    # platform + tenant migrations (RLS, grants)
pnpm rls:check     # static tenant-isolation gate
pnpm test          # unit tests
pnpm --filter @univarse/db test:int   # cross-tenant isolation tests against the real DB
```

Use `PGPORT=5433 pnpm db:setup` if your PostgreSQL 18 runs on another port.
