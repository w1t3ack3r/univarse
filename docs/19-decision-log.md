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

**Override log:**
- `source-map-js >=1.2.2 <2` (2026-10-06): GHSA-68fv-2mgg-jv7q, high; a crafted source map ties up the event loop. It reaches us only through build and test tooling (`unplugin-swc → vite → postcss`), never the API runtime. It blocked the route-sweep PR (#25), which is the gate working as intended. Pinned after the full suite passed (build, lint, unit, integration, E2E 30). **Remove** once `postcss` depends on `source-map-js` 1.2.2 or later.

## ADR-018 — Direct field encryption with one server key (temporary deviation from envelope encryption)
**Status:** Accepted as a **temporary deviation** (2026-10-01). Does **not** yet implement the envelope scheme in [07 §8](07-data-and-database.md) or spec 0001 M1. **Must be closed before staging.**
**Context:** TOTP secrets must never be stored in plaintext (spec 0001 M1). The target design is envelope encryption: a per-tenant DEK wrapped by a KMS key. No KMS exists in Phase 0 (no cloud environment yet).
**What is implemented (be precise):** **direct** encryption. Each secret is encrypted with **one platform-wide key**. There is **no data key and no separate wrapping key**, so this is *not* envelope encryption (OWASP Cryptographic Storage: a DEK protected by a separate KEK). AAD binding (below) is a different property: it stops ciphertext being moved between rows or tenants, but it does nothing to protect or separate keys.
**Decision:** AES-256-GCM with a 96-bit random IV, stored as a versioned string `v1:<keyId>:<iv>:<ct>:<tag>`. **AAD = `<tenantId>:<userId>:<purpose>`**, so a ciphertext copied to another row or tenant fails authentication. Phase 0 reads one key from `DATA_ENCRYPTION_KEY` / `DATA_ENCRYPTION_KEY_ID` (secret manager in deployed environments, `.env` locally, generated per run in CI). The keyring already supports multiple key IDs for rotation.
**Consequences:** One platform-wide key until KMS exists: a leaked key exposes **all tenants'** TOTP secrets, there is no per-tenant crypto-shredding on offboarding, and rotation means re-encrypting every value. Mitigations: the key lives only in the secret manager, never in the DB; AAD binding; rotation path ready. **Exit criteria (before staging):** per-tenant DEKs, wrapped by a KMS key (KEK), unwrapped in memory with a TTL cache. New format `v2:<kekId>:<wrappedDekRef>:…`, a background re-encryption of `v1` values, and a test proving a tenant's values become undecryptable when its DEK is destroyed. The `v1` format keeps the key ID, so existing values remain decryptable during migration.

## ADR-019 — Phase 0 outbox worker without BullMQ
**Status:** Accepted (2026-10-04). Defers part of ADR-008.
**Context:** ADR-008 plans outbox rows relayed to BullMQ. Phase 0 has one side effect (email) and must make it durable now (spec 0001 R15a). BullMQ adds a second persistence layer (Valkey) and relay code before there's any fan-out need.
**Decision:** A worker entrypoint claims due `outbox_event` rows directly with `SELECT … FOR UPDATE SKIP LOCKED` under each tenant's RLS context, with exponential backoff and a dead state after 8 attempts (spec 0002 Part B). Payloads are field-encrypted and wiped after delivery.
**Consequences:** Postgres is the only system of record for side effects, and claiming is transactional. Polling adds latency (seconds) and load proportional to the poll interval times the number of tenants. **Revisit trigger:** more than one job type that needs priorities, fan-out or rate-limited queues, or polling load that becomes visible in DB metrics.

## ADR-020 — Product-suite architecture: independently enabled, isolated products in one codebase
**Status:** Accepted (2026-10-04). Refines ADR-003 (modular monolith) and ADR-012 (one staff workspace).
**Context:** UniVarse is an ecosystem of products (Core, Admissions, Bursary, Academics, Teaching & Learning, Assessment/CA CBT, Student Affairs, Helpdesk & Comms, Reporting; [01 §5.1](01-product-brief.md)). Like a workspace suite, each must work **on its own and with the others**: institutions enable products independently, and a spike or failure in one (e.g. 2,000 students starting a CA test at once) must not degrade another (e.g. fee payment). A single undifferentiated process can't guarantee that.
**Decision:**
1. **Products are first-class in the code.** Every NestJS module declares the product it belongs to. Cross-product interaction goes only through that product's published service contract or its domain events (outbox). No product reads another product's tables (already ADR-003 rule 1; now also enforced across products by dependency-cruiser).
2. **Entitlements are enforced server-side.** A platform-managed `tenant_product` registry (cached) plus a route-level `@Product('assessment')` declaration. Requests to a disabled product get `404` (it doesn't exist for that tenant), and jobs for disabled products are skipped. Hiding it in the UI alone isn't enough.
3. **Runtime roles, configured not coded.** One image. Each process starts with `PRODUCTS=…` and mounts only those products' controllers and consumers:
   - `api` (Core + Admissions + Bursary + Academics + Student Affairs + Helpdesk + Reporting)
   - `api-learning` (Teaching & Learning + Assessment HTTP)
   - `realtime` (WebSocket/SSE for live lecture engagement and CBT session heartbeats)
   - `worker` (per-product queues)

   The edge routes by path prefix. In dev everything can run in one process (`PRODUCTS=all`).
4. **Bulkheads per product:** separate DB connection-pool budgets (PgBouncer pools per runtime role), separate job queues with their own concurrency caps, per-product rate-limit buckets, timeouts and circuit breakers on any cross-product call, and per-product SLO dashboards.
5. **Shared foundations stay shared:** identity, permissions, audit, tenancy and the design system are Core and used by every product.

**Consequences:** Products can be scaled, deployed (same image, different role) and degraded independently. The extra discipline required is contracts and events over direct calls, and product declarations on every module and route. Cost: more processes to operate in prod. The split is by configuration, so it can start as one process and divide when load demands. **Test obligation:** a cross-product isolation load test (saturate Assessment, assert Bursary p95 within SLO) is a GA gate ([01 §7](01-product-brief.md)).
**Alternatives:** Microservices per product (distributed transactions and an ops burden for one team). A single process (no isolation guarantee).

## ADR-021 — Federation principles for future inter-institution access ("campus embassies")
**Status:** Accepted as **design principles only** (2026-10-04). Nothing is built yet ([01 §5.5](01-product-brief.md)).
**Context:** The long-term vision is that a student of one UniVarse institution can attend classes or take tests at a nearby UniVarse institution, so each campus acts as an "embassy" for the others. This must never be achieved by weakening tenant isolation (ADR-004).
**Decision (constraints any future design must satisfy):**
1. **Each institution remains the data controller of its own students** (NDPA). There are no shared tables or cross-tenant reads. All cross-institution interaction is **platform-mediated**, through the control plane.
2. **Explicit bilateral federation agreements** (home ↔ host), scoped to named offerings or tests, time-bound, revocable, and audited on both sides. No agreement, no access.
3. **Guest access, not membership.** The host sees a minimal, purpose-limited guest projection (name, home matric, photo for identity checks). The student's account and record stay at home. Identities remain per tenant. An optional platform-level "UniVarse ID" linking accounts would need the student's explicit consent and its own ADR.
4. **Results flow home as signed records** (host-signed, verifiable). The home institution's grading and approval rules apply. The host never writes to the home tenant directly.
5. **Lawful transfer between controllers** (DPA between institutions and a documented lawful basis) before any personal data crosses tenants.

**Consequences:** Today's code must not assume a person belongs to two tenants, and must not add cross-tenant joins. Both are already prevented by RLS and composite FKs. A future "federation" control-plane module will own agreements and signed record exchange.

## ADR-022 — UniVarse Live: our own live-lecture experience on a self-hosted open-source media server
**Status:** Accepted (2026-10-05). Supersedes the "integrate Meet/Zoom/Jitsi" row in [05 §18](05-modules-and-features.md).
**Context:** Live lectures should feel built for UniVarse: joined from the course page, access by registration, automatic attendance, our polls and Q&A in the call, recordings in the course space, all under our audit and tenant isolation. Building a real-time media engine (WebRTC SFU, TURN, simulcast, recording) from scratch is years of specialist work and not where UniVarse differentiates.
**Decision:** **Own the experience, not the codec.** Self-host an open-source SFU (**LiveKit**, preferred: Apache-2.0, server SDKs, recording/egress). Everything around it is UniVarse:
- room creation per live session,
- short-lived join tokens minted by our API only for registered members (permissions by role: lecturer publishes, students subscribe and request to speak),
- attendance from presence plus the existing check-in,
- polls/Q&A on the `realtime` role,
- recordings stored as course materials (scanned, presigned),
- every join, leave, role change and recording action audited.

**Designed for Nigerian networks:** audio + slides by default, video optional, simulcast with low layers, adaptive bitrate, low-data mode, and short downloadable recordings for students who missed it.
**Video is optional but implemented** (confirmed 2026-10-05): it ships in Phase 4c, not as a later add-on. Every session starts in audio + slides. The lecturer can turn on camera and screen share at any time, and the institution can allow or disallow student cameras per course. Each participant can choose to receive audio-only (low-data mode) whatever the others publish. Recordings follow the session's mode, so a video session also gets an audio + slides rendition for low-data download.
**Consequences:** We run media infrastructure: SFU nodes, TURN, egress bandwidth (cost-tracked per tenant) and recording storage. It's a separate product capability within Teaching & Learning (entitlement `teaching`, sub-feature flag `teaching.live`). It needs its own load test (target: 300 participants per room on constrained bandwidth). **Phasing:** in-lecture engagement (attendance/polls/Q&A for in-person lectures) ships in Phase 4b. UniVarse Live (media) follows as Phase 4c, after a cost and bandwidth spike.
**Alternatives:** Pure integration with Meet/Zoom (fast, but outside our identity, audit and data control). Building an SFU from scratch (excessive effort and risk).

## ADR-023 — Key-encryption key in self-hosted Vault Transit (envelope encryption)
**Status:** Accepted (2026-10-05). Implements spec 0006 D1. Together with spec 0006, it closes the ADR-018 deviation once staging runs it.
**Context:** Spec 0006 needs a key-encryption key (KEK) that wraps per-tenant data keys (DEKs) and never lives in a database or in application memory. Options were a cloud KMS (AWS KMS `af-south-1`), self-hosted HashiCorp Vault Transit, or a KEK held in the secret manager.
**Decision:** **HashiCorp Vault, Transit secrets engine**, run by UniVarse.
- **The KEK** is a Transit key of type `aes256-gcm96` with `derived=true`. Each wrap and unwrap passes a **context** of `univarse:dek:<tenantId>:<version>`, so Vault derives a distinct key per tenant DEK. A wrapped DEK moved to another tenant or version will not unwrap (spec 0006 E2).
- **The app only calls `transit/encrypt` and `transit/decrypt`.** Its Vault policy allows nothing else. Key creation and rotation (`transit/keys/<name>/rotate`, `rewrap`) are operator actions under a separate policy.
- **Authentication:**
  - Local: a dev-mode token.
  - Deployed: AppRole, with the secret ID delivered by the secret manager. Kubernetes auth comes when Phase 3 moves to k8s.
  - Vault runs with TLS on a private network, never exposed to the internet.
- **Local and CI** run a Vault dev server (pinned image). The `local` provider remains for unit tests only.
- **Built against the Transit HTTP API that OpenBao also implements**, with no Vault-Enterprise features, so OpenBao is a drop-in replacement.

**Licence note:** Vault is under the Business Source License 1.1 since August 2023. Using it to protect our own service is permitted; offering Vault itself as a competing product is not, and we won't. **OpenBao** (Linux Foundation, MPL-2.0) is the API-compatible fork, and our exit if the licence terms or pricing change.
**Consequences:**
- **We operate Vault:** HA (3-node Raft) before production, unseal (auto-unseal via a cloud KMS or a transit seal when we move to managed infrastructure), Raft snapshots in the backup plan, audit devices enabled, and the KEK version recorded on every wrapped DEK.
- **Cost:** a Vault call per uncached DEK, made cheap by the 1-hour DEK cache (spec 0006 E5).
- **Availability:** a Vault outage blocks only tenants whose DEK isn't cached (spec 0006 E6, fail closed). Vault availability belongs in the staging and production SLOs.
- **Dedicated in-country deployments:** these get their own Vault (or OpenBao), which suits Nigerian data-residency requirements.

**Alternatives:**
- **AWS KMS:** less to operate, but ties keys to one cloud and doesn't fit in-country dedicated deployments.
- **Secret-manager KEK:** the KEK sits in process memory. Acceptable only as a stop-gap, and not chosen.

## ADR-024 — Local-first until the application is complete; cloud staging deferred
**Status:** Accepted (2026-10-05, owner decision).

**Context:** [Spec 0008](specs/0008-staging-environment.md) planned AWS staging at about $190/month (partly verified). The application work (settings, the API isolation route sweep, uploads, API contracts, observability) doesn't need the cloud.

**Decision:**
- Build and verify everything locally (compose, real Vault, real Postgres) and in GitHub CI.
- Cloud staging waits until the application is complete. Spec 0008 stays as the plan for then, with its estimate.
- When it's useful, a **local staging profile** rehearses what staging was for:
  - production images under the hardening rules;
  - HTTPS with a local certificate authority installed on test devices, for real `Secure` cookies and an enforced CSP;
  - Vault with TLS and its audit device;
  - LAN access for real phones, through a name that resolves to the host (e.g. `*.<lan-ip>.sslip.io`).

**Consequences:**
- **Phase 0 can't fully close.** Its staging-only exit criteria are recorded as **deferred**, not done:
  - CSP and HTTPS cookies on staging;
  - an automatic deploy from `main`;
  - backups with a rehearsed restore;
  - ADR-018 closure, which needs staging to run the `vault` provider.
- **Image scanning and signing don't need staging.** They move into CI.
- **The developer machine is the only copy** of local Vault keys and data. It holds synthetic data only, never real personal data.
- **Docker needs about 8 GB** once ClamAV and Gotenberg run.

## ADR-025 — SeaweedFS as the local and CI S3-compatible store (MinIO is unmaintained)
**Status:** Accepted (2026-10-06). Resolves the S3 row ADR-015 deferred ("Evaluate MinIO vs Garage/SeaweedFS", milestone: files module).

**Context:** The blueprint named MinIO for local object storage. On 2026-10-06 its open-source server repository (`minio/minio`) is **archived** and marked unmaintained; LocalStack's repository is archived too. Production uses a managed S3-compatible service ([10](10-infrastructure-and-deployment.md)), so the local store only has to speak the S3 API faithfully enough to exercise our code. It must also be maintained, small, and suitable for CI.

**Options checked** (GitHub, 2026-10-06):

| Option | Licence | Status | Releases | Notes |
|---|---|---|---|---|
| **SeaweedFS** | Apache-2.0 | Active | 4.48 (2026-09-28), 4.47, 4.46: every 1–2 weeks | Single container with an S3 gateway, years of production use. Image `chrislusf/seaweedfs:4.48`, 92 MB compressed |
| Garage | AGPL-3.0 | Active | Published on its own forge | Built for geo-distributed small clusters |
| RustFS | Apache-2.0 | Active | 1.0.0 (2026-09-16), 1.0.1 | Young: 1.0 three weeks old |
| versitygw | Apache-2.0 | Active | v1.8.0 (2026-09-04) | A gateway over a filesystem |
| Zenko CloudServer | Apache-2.0 | Active | 9.4.7 (2026-10-05) | Heavier, Node-based |
| MinIO | AGPL-3.0 | **Archived** | n/a | Rejected |

**Decision:**
- **SeaweedFS** (`chrislusf/seaweedfs`, pinned tag, then by digest per [09](09-container-security.md)) runs in dev Compose and as a CI service, S3 gateway only, bound to `127.0.0.1`.
- **Nothing may depend on a SeaweedFS-specific behaviour.** The upload design ([spec 0010](specs/0010-file-uploads.md)) is safe even if the backend enforces none of the optional S3 safeguards: conditional writes, signed `Content-Length`, presigned expiry.
- **Storage contract tests** record what the backend actually does. They are re-run against the production provider before staging.

**Consequences:**
- The docs that named MinIO now name SeaweedFS: 02, 09, 10, 12, 18 and `CLAUDE.md`.
- Behaviour differences between SeaweedFS and the production provider are caught by the contract tests, not assumed away.
- Re-evaluate if SeaweedFS stops releasing. The S3 API keeps a swap cheap.

