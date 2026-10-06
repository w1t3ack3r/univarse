# CLAUDE.md — UniVarse


## What this is
UniVarse: the multi-tenant operating platform for Nigerian tertiary institutions — a suite of independent products (Core, Admissions, Bursary, Academics, Teaching & Learning, Assessment/CA CBT, Student Affairs, Helpdesk & Comms, Reporting) with CIA (confidentiality, integrity, availability) as the first design constraint. The full blueprint is in `docs/`. **Read the relevant doc before changing a module.** Start at `docs/README.md`.

## Stack
TypeScript everywhere · pnpm + Turborepo · Next.js 16 (`apps/web`, `apps/console`) · NestJS 11/Fastify (`apps/api`: `main.ts` HTTP, `worker.ts` jobs) · Prisma + PostgreSQL 18 with RLS · Valkey/Redis + BullMQ · S3-compatible storage (SeaweedFS locally, ADR-025) · Gotenberg · ClamAV.

## Commands
```bash
pnpm dev:infra          # start local dependencies (compose)
pnpm db:migrate         # apply platform + tenant migrations, RLS, grants
pnpm db:seed            # demo tenants: demo-uni, test-poly
pnpm dev                # web :3000, console :3001, api :8080, worker
pnpm lint && pnpm typecheck
pnpm test               # unit
pnpm test:int           # integration (Testcontainers)
pnpm test:e2e           # Playwright
pnpm rls:check          # RLS/tenant_id checker — must pass
pnpm contracts:gen      # regenerate packages/api-client/openapi.json after contract/route changes (a unit test fails if stale)
```
Local tenant URL: `http://demo-uni.univarse.localhost:3000`

## Invariants — never violate
1. **Tenant isolation:** tenant data only via `ShardRegistry.forTenant` / `ShardRegistry.tx`. Never import the raw tenant PrismaClient. Every new tenant table gets `tenant_id` + forced RLS (run `pnpm rls:check`). Tenant comes from the Host, never from request input.
2. **Authorization:** every endpoint declares a permission. Use cases check scope against the **loaded resource**. Sensitive actions use `@RequireStepUp()`. Out-of-scope → 404.
3. **Money = `bigint` kobo. Scores/GPA = decimal.js / `numeric`.** Never floats.
4. **Business rules** live in `packages/domain` as pure functions and follow `docs/04-business-rules.md`. Institution differences are **settings**, never `if (tenant === …)`.
5. **Immutable records:** `course_result`, `ledger_entry`, `audit_event`, `score_sheet_event` are append-only. Corrections are amendments/reversals.
6. **Audit + outbox** inside the same transaction for consequential changes.
7. **Payments:** credit only after server-side verify or a signature-verified webhook. Everything is idempotent.
8. **No secrets or PII in code, logs, errors, URLs or fixtures.** No tokens in localStorage. No mock data in production code paths.
9. **Migrations:** expand → migrate → contract. No destructive change in the same release as the code change.
10. Use glossary terms (`docs/00-glossary.md`) in code.
11. **Products are independent** (ADR-020): every module and route declares `@Product()`; cross-product interaction only via the other product's published contract or its events — never its tables. A product's spike or failure must not degrade another.
12. **CIA first** (docs/01 §6): every consequential action (results, CA attempts/scores, payments, auth, roles, sensitive-data access) is audited in the same transaction; integrity signals are logged for humans, never auto-punished.

## How to work
- Build **vertical slices**: contract (zod) → migration → domain → use case → controller → UI → tests → docs.
- For multi-module or schema-changing work, **plan first** and list the affected docs sections.
- Tests are required: unit for domain logic, integration with the real DB for use cases (including a cross-tenant and an unauthorized case), E2E for journeys. See `docs/12-testing-strategy.md` Definition of Done.
- If implementation shows a doc is wrong or incomplete, update the doc in the same change. New tech/tenancy/security decisions need an ADR in `docs/19-decision-log.md`.
- Use `/code-review` before merging. Use `/security-review` for auth, RLS, payments, results, uploads and exports.
- Conventional Commits with the module as scope: `feat(results): …`.

## Where things are
- Module layout & rules: `docs/02-architecture.md` §5–6, `docs/17-coding-standards.md` §3
- Entities & state machines: `docs/03-domain-model.md`
- API conventions (errors, pagination, idempotency, ETags): `docs/06-api-guidelines.md`
- DB conventions, RLS, migrations: `docs/07-data-and-database.md`
- Security controls: `docs/08-security.md`. Containers: `docs/09-container-security.md`
- Current phase & exit criteria: `docs/18-roadmap.md`
