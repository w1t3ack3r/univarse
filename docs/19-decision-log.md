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

## ADR-014 — Explicit tenant context instead of AsyncLocalStorage
**Status:** Accepted (2026-09-30). Amends [02 §7.2](02-architecture.md) (sequence diagram and rule 3).
**Context:** The blueprint planned an AsyncLocalStorage (ALS) store holding `{tenantId, userId, perms}`, read implicitly by the DB layer. ALS context can be lost across some async boundaries (event emitters, pooled callbacks, some library hooks). A lost context either fails confusingly or, worse, invites "fallback" code. Implicit globals also hide which code touches tenant data.
**Decision:** Tenant context is **passed explicitly**. `TenantGuard` resolves the tenant from the Host and attaches `TenantContext` to the request. Handlers receive it via `@CurrentTenant()` and pass `(shardId, tenantId)` to `ShardRegistry.forTenant()` / `ShardRegistry.tx()`. Jobs carry `tenantId` in their payload and do the same. There are no module-level "current tenant" variables anywhere.
**Consequences:** One extra parameter per call chain. Tenant data access is grep-able and obvious in review. RLS remains the enforcement layer either way: a missing context still fails closed at the database.
**Alternatives:** ALS (implicit, fragile). Request-scoped Nest providers (a DI performance cost on every request, and still implicit).

## ADR-015 — Local development topology (Phase 0) vs. the planned stack
**Status:** Accepted (2026-09-30). Amends [10 §4](10-infrastructure-and-deployment.md).
**Context:** The blueprint's `compose.dev.yml` lists Postgres, PgBouncer, Valkey, MinIO, Mailpit, Gotenberg and ClamAV. The dev machine already runs PostgreSQL 18 natively, and the network is slow (large image pulls take a long time and time out).
**Decision:** Introduce each dependency **when the first feature needs it**, and record the gap explicitly:

| Dependency | Planned | Phase 0 status | Added when |
|---|---|---|---|
| PostgreSQL 18 | compose | **Native host install** (`pnpm db:setup` creates least-privilege roles). CI uses the `postgres:18` service container | — |
| PgBouncer (transaction mode) | compose + prod | **Not yet.** App connects directly. RLS context is already transaction-local (`set_config(…, true)`), so it's PgBouncer-safe by design | Before the staging environment. Add a CI job running the isolation suite *through* PgBouncer |
| Valkey | compose | **Running** (compose, hardened, 127.0.0.1) | Now: rate limits |
| Mailpit | compose | **Running** | Now: activation codes |
| S3-compatible storage | MinIO | **Not yet.** MinIO's community image distribution changed in 2025 `[VERIFY]`. Evaluate MinIO vs Garage/SeaweedFS behind the S3 API | Files module (uploads) |
| Gotenberg, ClamAV | compose | Defined under the `docs` profile, not pulled | Documents / uploads |

**Consequences:** Faster Phase 0. The Postgres versions in dev and CI must match (both 18). A PgBouncer compatibility gap exists until staging, mitigated by the transaction-local design and a planned CI job.

## ADR-016 — Password hashing with Node's built-in Argon2id
**Status:** Accepted (2026-09-30)
**Context:** [08 §3.1](08-security.md) mandates Argon2id. The `argon2` npm package is a native addon: an install script plus prebuilt binaries, which is supply-chain surface ([09 §1](09-container-security.md)). Node ≥ 24.7 ships `crypto.argon2()`.
**Decision:** Use `crypto.argon2('argon2id', …)` with `m=19456 KiB, t=2, p=1`, a 16-byte salt and a 32-byte tag, stored as a standard PHC string (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`) so we can rehash or migrate later. Measured at ~260 ms per hash on the dev machine.
**Consequences:** No native dependency. The API is marked experimental in Node 24, so pin the Node minor in images, cover it with tests (known-answer + round-trip), and keep the PHC format so we can switch implementations without resetting passwords.

## ADR-017 — Security overrides for transitive pins; dependency audit gate
**Status:** Accepted (2026-10-01)
**Context:** Enabling Dependabot surfaced 30 alerts on day one. `nodemailer` 7.x had high-severity advisories, including cross-tenant SMTP credential disclosure through a process-global DNS/TLS cache. `@nestjs/platform-fastify` 11.2.x pins `fastify` **exactly** to 5.11.3, which is affected by an X-Forwarded-\* spoofing advisory and a schema-validation bypass (fixed in 5.12.1). The Prisma CLI pulls vulnerable `mysql2` (never executed: we use `pg`) and `deepmerge-ts`.
**Decision:**
1. Upgrade direct dependencies to patched versions: nodemailer ^10.0.11, vitest ^4.1.11 (the smallest patched major, not 5).
2. Where a framework pins a vulnerable transitive version, use **`pnpm.overrides`** to the version the framework's *next* major already ships (fastify 5.12.5, the same version NestJS 12 uses), and only after the full suite passes.
3. CI runs `pnpm audit --audit-level high` right after install. A high or critical advisory fails the build.
**Consequences:** Overrides must be revisited on every framework upgrade and removed once the framework catches up. The NestJS 12 upgrade (ADR-013) will retire the fastify override. The audit gate can block unrelated PRs when a new advisory lands. That's intended: fix or explicitly document an exception with an expiry.

## ADR-018 — Direct field encryption with one server key (temporary deviation from envelope encryption)
**Status:** Accepted as a **temporary deviation** (2026-10-01). Does **not** yet implement the envelope scheme in [07 §8](07-data-and-database.md) or spec 0001 M1. **Must be closed before staging.**
**Context:** TOTP secrets must never be stored in plaintext (spec 0001 M1). The target design is envelope encryption: a per-tenant DEK wrapped by a KMS key. No KMS exists in Phase 0 (no cloud environment yet).
**What is implemented (be precise):** **direct** encryption. Each secret is encrypted with **one platform-wide key**. There is **no data key and no separate wrapping key**, so this is *not* envelope encryption (OWASP Cryptographic Storage: a DEK protected by a separate KEK). AAD binding (below) is a different property: it stops ciphertext being moved between rows or tenants, but it does nothing to protect or separate keys.
**Decision:** AES-256-GCM with a 96-bit random IV, stored as a versioned string `v1:<keyId>:<iv>:<ct>:<tag>`. **AAD = `<tenantId>:<userId>:<purpose>`**, so a ciphertext copied to another row or tenant fails authentication. Phase 0 reads one key from `DATA_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY_ID` (secret manager in deployed environments, `.env` locally, generated per run in CI). The keyring already supports multiple key IDs for rotation.
**Consequences:** One platform-wide key until KMS exists: a leaked key exposes **all tenants'** TOTP secrets, there is no per-tenant crypto-shredding on offboarding, and rotation means re-encrypting every value. Mitigations: the key lives only in the secret manager, never in the DB; AAD binding; rotation path ready. **Exit criteria (before staging):** per-tenant DEKs, wrapped by a KMS key (KEK), unwrapped in memory with a TTL cache. New format `v2:<kekId>:<wrappedDekRef>:…`, a background re-encryption of `v1` values, and a test proving a tenant's values become undecryptable when its DEK is destroyed. The `v1` format keeps the key ID, so existing values remain decryptable during migration.
