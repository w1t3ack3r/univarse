# 19 — Decision Log (ADRs)

Architecture Decision Records, newest at the bottom. **Status:** Proposed → Accepted → (Superseded by ADR-nnn | Deprecated). Never edit an accepted ADR's decision. Supersede it with a new one.

### Template
```
## ADR-NNN — Title
Status: Proposed | Accepted (YYYY-MM-DD) | Superseded by ADR-XXX
Context: the forces at play, the problem.
Decision: what we will do.
Consequences: positive, negative, follow-ups.
Alternatives considered: option — why not.
```

---

## ADR-001 — Record architecture decisions
**Status:** Accepted (2026-09-30)
**Context:** A long, solo + AI-assisted build loses the "why" quickly. v0 decisions (Laravel service, DB-per-tenant, JWT in localStorage) left no rationale.
**Decision:** Every significant technical decision is an ADR in this file. Docs in `docs/` are updated in the same PR.
**Consequences:** A small overhead per decision. Future changes are cheaper and safer.

## ADR-002 — Single-language TypeScript monorepo; drop the Laravel service
**Status:** Accepted (2026-09-30)
**Context:** v0 had Next.js, an Express auth service, and an untouched Laravel skeleton meant for "academic" features. Two languages double tooling, security scanning, images and the knowledge needed.
**Decision:** TypeScript for all apps and packages in one pnpm + Turborepo monorepo. Shared zod contracts give type safety across the API boundary.
**Consequences:** One toolchain, shared types, simpler CI. PHP ecosystem packages aren't used.
**Alternatives:** Laravel for the backend (mature, batteries-included, but a second language and no shared types). Go (performance we don't need, slower iteration).

## ADR-003 — Modular monolith on NestJS (Fastify adapter)
**Status:** Accepted (2026-09-30)
**Context:** Many tightly-linked domains (registration ↔ fees ↔ results) that need transactional consistency. Solo operator. Microservices would add distributed transactions, more deployments and network failure modes.
**Decision:** One backend deployable (`apps/api`) with strict internal module boundaries ([02 §6](02-architecture.md)), two entrypoints (HTTP, worker). NestJS for DI/guards/modules, Fastify for throughput.
**Consequences:** Simple ops and ACID across modules. Boundaries must be enforced by lint/CI to avoid a big ball of mud. A module can be extracted later if it's ever justified.
**Alternatives:** Plain Express (v0: little structure at scale). Microservices (premature). tRPC-only (weak for the public/OpenAPI and webhook surfaces).

## ADR-004 — Tenancy: pooled databases with forced RLS by default, dedicated databases on demand
**Status:** Accepted (2026-09-30)
**Context:** v0 used DB-per-tenant, but its IT-admin code wrote to a shared DB, so isolation depended on every query being right. Per-tenant DBs complicate migrations, pooling and cross-tenant ops. Some institutions may contractually require their own database.
**Decision:** All tenant tables carry `tenant_id` with **ENABLE + FORCE RLS** policies bound to a transaction-local `app.tenant_id`. The app role can't bypass RLS. Tenants live in **pool shards** by default. A **dedicated shard** (same schema, same RLS) is available per tenant. The tenant registry maps tenant → shard.
**Consequences:**
- The database enforces isolation, so a forgotten `where` fails closed.
- One migration path.
- Cheaper to operate.
- Single-tenant restore needs logical per-tenant exports (built in).
- Noisy neighbours are mitigated by rate limits and by promoting big tenants.
- Every transaction runs a `set_config` (negligible cost).
**Alternatives:** DB-per-tenant only (ops burden). Schema-per-tenant (Prisma friction, catalog bloat). App-level filtering only (one bug = breach).

## ADR-005 — Server-side sessions in HttpOnly cookies
**Status:** Accepted (2026-09-30)
**Context:** v0 stored JWTs in `localStorage` (XSS-exfiltratable) and had hard-to-revoke tokens. We need instant revocation (role removal, compromised accounts) and step-up tracking.
**Decision:** Opaque random session IDs in `__Host-` HttpOnly Secure SameSite=Lax cookies. Session state is in Redis with a durable Postgres record. Fetch-Metadata/Origin checks for CSRF.
**Consequences:** Immediate revocation and a simple client. Needs a Redis lookup per request (cached, cheap). Future mobile apps will use a separate token flow (OAuth 2.1 + PKCE) via a new ADR.
**Alternatives:** JWT access + refresh tokens (revocation complexity, larger attack surface in the browser).

## ADR-006 — Prisma ORM, with SQL for RLS, grants and advanced constraints
**Status:** Accepted (2026-09-30)
**Context:** The developer knows Prisma. We need type-safe queries, migrations, and full control over PostgreSQL security features.
**Decision:** Prisma for models, queries and migrations. Custom SQL appended to migrations for RLS policies, grants, partial indexes, triggers and extensions. Tenant access only via a client extension that sets RLS context.
**Consequences:** Productivity and type safety. Some SQL lives outside the Prisma schema (checked by the RLS checker and migration linter). Complex reporting queries use typed raw SQL (`$queryRaw` tagged templates / TypedSQL).
**Alternatives:** Drizzle (closer to SQL and great RLS ergonomics, but a learning curve), Kysely (query builder only). Revisit if Prisma blocks RLS patterns.

## ADR-007 — Same-origin API behind the edge; separate console host
**Status:** Accepted (2026-09-30)
**Context:** Cross-origin API calls need CORS and third-party-cookie workarounds. Platform administration is the highest-value target.
**Decision:** The edge routes `https://{tenant-host}/api/*` to the API and everything else to Next.js. The platform console lives on `console.univarse.ng` with its own cookie, CSP and IP allowlist. Webhooks use `api.univarse.ng` (cookie-less).
**Consequences:** No CORS. First-party cookies. A clean blast-radius separation for the console.

## ADR-008 — Transactional outbox + BullMQ for async work
**Status:** Accepted (2026-09-30)
**Context:** Cross-module reactions (payment → unlock registration, publication → notifications) must not be lost or duplicated, and must not run inside request latency.
**Decision:** Domain events are written to `outbox_event` in the business transaction. A relay publishes them to BullMQ queues on Valkey/Redis, and consumers are idempotent.
**Consequences:** At-least-once delivery with idempotent handlers. Redis is operationally required. The outbox table needs cleanup.
**Alternatives:** Direct enqueue after commit (lost events on crash). Kafka/RabbitMQ (heavier to operate than needed).

## ADR-009 — Money as integer kobo; exact decimals for academic maths
**Status:** Accepted (2026-09-30)
**Decision:** Monetary values are `bigint` kobo in the DB and code (`Kobo` branded type), formatted only in the UI. Scores/GPAs use `numeric` in the DB and `decimal.js` in code, with rounding rules from tenant config.
**Consequences:** No float drift in invoices or CGPA boundaries. Slightly more verbose code.

## ADR-010 — Gotenberg for PDF generation
**Status:** Accepted (2026-09-30)
**Context:** Transcripts, receipts, dockets and letters need pixel-accurate, printable output. Embedding Chromium in the API image enlarges the attack surface and image size.
**Decision:** HTML/CSS templates are rendered to PDF by an internal Gotenberg service (network-isolated, JavaScript disabled), called only from the worker.
**Consequences:** The main images stay small and hardened. One more internal service to operate.
**Alternatives:** Playwright in the worker image (heavier image, broader attack surface), react-pdf (limited layout fidelity).

## ADR-011 — Institutions own their payment gateway accounts
**Status:** Accepted (2026-09-30)
**Context:** Collecting fees on behalf of institutions would put UniVarse in a payment-intermediary role (licensing, liability, reconciliation of settlements). Federal institutions must use TSA/Remita.
**Decision:** Each tenant connects its own Paystack/Flutterwave/Remita credentials. Funds settle directly to the institution. UniVarse orchestrates, verifies and reconciles. Its own revenue comes via separate platform billing.
**Consequences:** Lower regulatory exposure. Secrets per tenant must be encrypted and handled carefully. Onboarding includes gateway setup.

## ADR-012 — Permission-driven staff workspace instead of per-role portals
**Status:** Accepted (2026-09-30)
**Context:** v0 built separate portals (`/it-admin`, `/dean`, …), duplicating layouts and logic. Real staff hold several roles at once (Lecturer + HOD + Level Adviser), and roles differ per institution.
**Decision:** One `/staff` workspace. Navigation and actions are derived from effective permissions and scopes. Student, applicant and console surfaces remain separate.
**Consequences:** No duplicated screens, and custom roles work automatically. It needs a well-designed permission catalog and nav registry.

## ADR-013 — Rebuild in place; pin a proven toolchain for Phase 0
**Status:** Accepted (2026-09-30)
**Context:** We rebuild inside the existing folder. The v0 prototype is preserved in git as tag `v0-prototype` (secrets scrubbed). At rebuild time the newest majors were TypeScript 7 (native compiler), NestJS 12, Vitest 5 and pnpm 12. Decorator support, ecosystem compatibility and config changes in those majors weren't yet verified for this stack.
**Decision:** Phase 0 pins TypeScript ~5.9, NestJS 11, Prisma 7 (the `prisma-client` generator + `@prisma/adapter-pg`), Vitest 3, pnpm 10 and Node 24 LTS. Upgrading to the newer majors is a scheduled task after Phase 0 exit, done one major at a time with CI green.
**Consequences:** A known-good foundation now, and a small upgrade task later. The docs mention "NestJS 11" deliberately.
