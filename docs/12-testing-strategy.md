# 12 — Testing Strategy & Definition of Done

## 1. Principles

- **Correctness of academic and financial numbers is non-negotiable.** Domain engines have the densest tests in the codebase.
- **Tenant isolation is tested automatically, for every table and every repository**, not by hand.
- Test the behaviour at the lowest level that gives confidence. E2E is for journeys, not for every branch.
- A bug fix starts with a failing test.

## 2. Test pyramid

| Layer | Tool | Scope | Runs |
|-------|------|-------|------|
| Unit (domain) | Vitest + **fast-check** (property-based) | `packages/domain`: grading, GPA/CGPA, standing, degree audit, fee rule matching, matric generator, state machines, policy engine | Every commit (< 30 s) |
| Unit (app) | Vitest | Use cases with in-memory ports, mappers, validators | Every commit |
| Integration | Vitest + **Testcontainers** (Postgres 18, Valkey, SeaweedFS for S3, ClamAV) | Repositories, use cases with the real DB + RLS, migrations, outbox, job processors | Every PR |
| Contract | Generated OpenAPI + schema tests; oasdiff against the PR base; real-response conformance ([spec 0011](specs/0011-openapi-and-api-client.md)) | Stale generated files (CI regenerates and diffs); breaking API changes (reported, and acknowledged in the PR description); every integration response checked against the document as sent. Event schemas: tracked | Every PR |
| E2E | **Playwright** against the compose stack | Critical journeys ([§5](#5-critical-e2e-journeys)) on desktop + mobile viewport | PR (smoke subset), `main` (full) |
| Load | **k6** | Peak scenarios ([§6](#6-performance--load-testing)) | Before each phase exit & release; weekly on staging |
| Security | ZAP, Semgrep, CodeQL, Trivy, gitleaks | [08 §11](08-security.md) | PR / nightly / pre-release |
| Accessibility | axe (Playwright) | Key pages | `main` |

Coverage gates (line/branch):
- `packages/domain` **≥ 95% / 90%**
- API application layer ≥ 80%
- Overall ≥ 75%

Mutation testing (Stryker) on `packages/domain` runs nightly with a mutation score ≥ 80%.

## 3. Tenant isolation test suite (mandatory)

1. **Static:** the RLS checker (`tools/rls/check.ts`, [07 §3.3](07-data-and-database.md)) runs after migrations in CI.
2. **Dynamic (generic):** a test iterates all tenant tables and, with seeded tenants A and B:
   - context A: `SELECT` returns no B rows; `UPDATE/DELETE … WHERE id = <B row>` affects 0 rows; `INSERT` with `tenant_id = B` fails.
   - no context: `SELECT` returns 0 rows; `INSERT` fails.
3. **API level:** for each resource route (generated from the route table), request B's resource IDs with A's session on A's host → expect 404. Use A's session cookie on B's host → expect 401 + a security event.
4. **Jobs:** a job enqueued for A processes only A's data (assert via a spy on the tenant context).
5. **Caches/files:** keys and object paths are prefixed. A presigned URL for B's file can't be obtained by A.

Any failure here is a release blocker.

### 3.1 Current coverage of the five layers (update as modules land)

| Layer | Status | Where | Gap to close |
|-------|--------|-------|--------------|
| 1. Static (RLS checker) | ✅ Complete for current tables. Negative control verified (flags missing RLS, FORCE, policy, non-tenant unique, non-tenant FK) | `packages/db/scripts/rls-check.ts` (CI gate) | — |
| 2. Dynamic DB | ✅ **Complete.** Generic sweep over every tenant table discovered from `pg_catalog`, in two fresh tenants: read, update, move, delete, insert and no-context checks ([spec 0004](specs/0004-isolation-sweep.md)). A tenant table without a fixture fails the build. Hand-written FK and grant cases remain | `packages/db/test/isolation-sweep.int.spec.ts`, `isolation.int.spec.ts` | — (new tables are covered automatically, or the sweep fails) |
| 3. API | ✅ **Complete for today's routes** ([spec 0009](specs/0009-api-route-sweep.md)). The route table is captured from Fastify `onRoute` and cross-checked against Nest; every route is declared, and an unknown route fails the build.<br>**Current evidence** (CI run 38163384385, 2026-10-11): 46 Fastify registrations, 32 declared in Nest, **30 real routes swept**. Per route, the sweep checks:<br>• the legitimate operation first (RS0, 30);<br>• tenant hints (RS3, 72);<br>• credentials by kind, including the exact M8 allow-list (RS2: 22 credential, 1 restricted-session and 28 suspended-host probes);<br>• collections (RS4, 4) and keyed items (RS5, 3);<br>• account actions, with the same username in both tenants plus a second user (RS7, 5).<br>**Real resource-by-id routes: 4** (files, spec 0010 FU2), each swept by RS6 (4 checks), plus 2 synthetic controls that the sweep must detect on every run (RS8), and a production-build check that serves none of them | `apps/api/src/route-sweep.int.spec.ts` (+ the earlier hand-written cases) | RS6 for each new resource-by-id route: the sweep refuses to pass without its declaration |
| 4. Jobs | ✅ **Complete for today's jobs** ([spec 0014](specs/0014-job-isolation.md)).<br>• **Outbox worker: covered.** A pass for tenant A never claims B's events, and B's rows are invisible under A's context (live RLS). Inactive products' events wait. One pass across both tenants attributes every delivery to its own tenant and trace (spec 0012 OB8).<br>• **File-scan worker: covered** (JI1–JI4). A pass for A claims and finishes only A's uploads. A tenant-context spy and a storage spy show every call and object is A's, and in the production pass every storage operation carries its own tenant's log context. Cleanup never reaches B's objects. RLS blocks the claim even with B's id in its filter.<br>• **Key sweep: covered** (JI5–JI7). Only the claimed request's tenant is re-encrypted, and the other tenant's ciphertexts stay byte-for-byte unchanged. Each pass's tenant-context calls name only that tenant. Every column operation under A's context reaches none of B's rows, even with the tenant filters removed | `apps/api/src/shared/outbox/outbox.int.spec.ts` (B8, B10), `shared/observability/propagation.int.spec.ts` (OB8), `modules/files/file-scan.isolation.int.spec.ts`, `shared/crypto/key-sweep.isolation.int.spec.ts` | Each new job type adds the same claim test (a tenant-context spy, per pass) |
| 5. Caches / files | ✅ **Complete for today's caches and files.** **Files: complete for the first slice** ([spec 0010](specs/0010-file-uploads.md)): server-generated tenant-prefixed keys, private buckets, own-files-only with no existence oracle (RS6 on 4 real routes), presigned POST bound to one key, lease-unique clean keys. **Caches:** rate-limit keys are tenant-prefixed and settings cache keys are tenant-scoped (spec 0007). **Products and keys on the invalidation bus** ([spec 0015](specs/0015-cache-isolation.md)): an invalidation or forget reaches every API and worker instance within 2 s, and a message for A never evicts B. The keyring never returns or caches a stale key, and zeroes each key at its deadline. Future writers of tenant hosts/status and entitlements are bound by a guard test. **Platform invalidation capture** ([spec 0016](specs/0016-platform-invalidation-outbox.md)): every write to `tenant`, `tenant_domain` and `tenant_product`, by any writer (a raw connection, the migrator, a stored function, dynamic SQL, a type that lies), reaches both API instances within 2 s; the relay publishes at least once with a bounded pass; the resolver evicts negative entries and guards in-flight lookups with a global generation; cache deadlines are monotonic; the capture's integrity is a `pnpm rls:check` gate. The shred ledger isn't a cache-isolation check; it's tracked under crypto-shredding and restore safety (spec 0006, with backups) | `modules/files/files.int.spec.ts`, `route-sweep.int.spec.ts`, `shared/infra/rate-limiter.ts`, `shared/infra/cache-isolation.int.spec.ts`, `shared/infra/cache-writers.spec.ts`, `packages/crypto/src/keyring.spec.ts`, `packages/db/test/cache-invalidation.int.spec.ts`, `shared/infra/platform-invalidation-relay.int.spec.ts`, `shared/tenancy/tenant-invalidation.int.spec.ts`, `shared/tenancy/tenant-resolver.spec.ts` | Each new cache of tenant-scoped state goes on the bus, with the same tests |

**Authorization ([spec 0018](specs/0018-policy-service.md)):** the policy's matrix covers every permission × scope type × MFA × step-up (`modules/identity/policy.spec.ts`); each of the five resource scopes is refused end to end, with an institution control and a cross-tenant case (`modules/identity/policy.int.spec.ts`); a static guard keeps grant reads inside the policy (`modules/identity/policy-guard.spec.ts`).

### 3.2 Through PgBouncer, in transaction mode ([spec 0017](specs/0017-pgbouncer-isolation.md))

Every layer above also holds through the intended pooling mode. Two CI jobs, both meant to be required on `main`, prove it:

- **`pgbouncer-isolation`:**
  - **The probes,** in the probe profile (2 server connections), where sharing and saturation are certain:
    - PB1, real transaction pooling, and a session canary that leaks;
    - PB2, 1 000 interleaved tenant reads with exact ids and values, and no leftover context on a shared backend;
    - PB5, UTC in two independent halves;
    - PB6, no reliance on named prepared statements;
    - PB7, PgBouncer's queue timeout shed as `503 server.busy` through the API;
    - PB9, authentication, a read-only owner-only auth file, and a real password rotation.
  - **The three isolation suites,** unchanged (DB isolation, crypto, API integration), in the suite profile (10).
- **`pgbouncer-compare`:** it joins that run with `build-test`'s direct run. It requires the same test files, the same tests, every test passing through PgBouncer, and the same skips. It fails unless both runs succeeded, so a skipped comparison never reads as a pass.
- **The static half (PB4):** `apps/api/src/shared/db/session-sql.spec.ts` shows that production code uses no session-scoped SQL ([07 §3.5](07-data-and-database.md)).

**Evidence (CI run 38876851157 on `f4442fe`, 2026-10-16):**
- **The probes:** PB7 3/3 and the others 13/13.
- **Through PgBouncer:** DB 31/31, crypto 10/10, API 369 passed + 1 skipped.
- **The comparison:** `PASS` against the direct run.
- **PB11's mutations** each fail their probe, run on an isolated stack:
  - session pooling;
  - `set_config(…, false)` in `withTenantTx`;
  - each PB5 half, and a skipped server reset;
  - the PB6 mutant;
  - no PB7 mapping;
  - a forced `user=`.

Mutation checks were run on the auth slice (2026-09-30). Disabling the permission check, CSRF, session expiry, or Host-based tenant resolution each made the suite fail.

## 4. Domain engine testing

- **Golden fixtures:** `packages/domain/fixtures/<tenant-or-generic>/*.json`. Real (anonymised) result sheets and broadsheets from the pilot institution, with the Senate-approved GPA/CGPA/class values. The engine output MUST match to the last digit. These fixtures are the contract with the institution.
- **Property-based tests (fast-check):**
  - 0 ≤ GPA ≤ 5
  - CGPA is a weighted mean of the semester GPAs by units
  - adding an A never lowers the CGPA; adding an F never raises it
  - permutation of course order doesn't change results
  - `ALL_ATTEMPTS_COUNT` vs `BEST_ATTEMPT` ordering properties
  - classification is monotonic in CGPA
  - rounding boundary cases (4.495, 3.4999, 1.495)
- **Configuration matrix:** tests run across grading schemes (with/without E), rounding modes and repeat policies.
- **State machines:** exhaustive transition tables (every state × every action → allowed/denied), generated from the machine definition.
- **Fee rule matching:** specificity ordering, overlap detection, instalment maths (sums exactly equal the total in kobo; the remainder goes to the last instalment).

## 5. Critical E2E journeys

| # | Journey |
|---|---------|
| J1 | Platform: create tenant → provisioning completes → institution admin activates account + sets up MFA |
| J2 | Institution setup: import org units, programmes, courses, curriculum → activate session/semester |
| J3 | Applicant: sign up → fill form → pay form fee (gateway test mode + simulated webhook) → submit → appear on merit list → accept offer → pay acceptance fee → enrolment → matric number issued |
| J4 | Student: activate → pay school fees → register courses (with carryover) → adviser approves → print course form |
| J5 | Exams: timetable with a clash warning → docket available only when eligible |
| J6 | Results: lecturer uploads CSV scores → submit → HOD returns → resubmit → HOD → Dean → Senate → publish → student sees GPA/CGPA matching the fixture |
| J7 | Amendment: request → approvals → student result + CGPA updated, audit shows before/after |
| J8 | Graduation: clearance (auto bursary check) → degree audit → graduation list approved → transcript requested, paid, generated → `/verify/{code}` shows valid |
| J9 | Hostel: apply → allocated (hold) → hold expires without payment → bed released |
| J10 | Security: cross-tenant access attempts, step-up required on approve, suspended tenant login blocked |

## 6. Performance & load testing

k6 scenarios in `tools/load/`, run against staging with a large-tenant dataset (60k students):

| Scenario | Profile | Pass criteria |
|----------|---------|---------------|
| Result release | Ramp to 10k VUs in 5 min, each: login → results → statement PDF (10%) | p95 < 800 ms, errors < 0.5%, no DB CPU > 80% |
| Registration opening | 5k VUs registering concurrently | p95 submit < 1.5 s, no lost/duplicate registrations |
| Payment webhook storm | 200 webhooks/s for 5 min | All processed, zero double credits |
| Staff steady state | 500 staff users, mixed workloads | p95 < 300 ms reads |
| Soak | 4 h at 30% peak | No memory growth > 10%, no connection leaks |

## 7. Test data management

- Factories (`packages/db/test/factories`) build valid aggregates with sensible defaults. Tests override only what matters.
- Each integration test runs in a transaction that's rolled back, or on a per-worker schema clone. Tests don't depend on order.
- Time is injected (`Clock` port). Tests never call `Date.now()` directly. Time-window tests freeze time in `Africa/Lagos`.
- External providers are **faked at the port boundary** (payment gateway fake with scripted outcomes, SMS/email sinks). There's also a nightly contract test against real gateway **sandbox** environments.

## 8. Definition of Done (every feature/PR)

- [ ] Behaviour matches the acceptance criteria in [05](05-modules-and-features.md). Rules match [04](04-business-rules.md)
- [ ] Unit + integration tests, including unauthorized and cross-tenant paths
- [ ] Domain changes: fixtures/property tests updated
- [ ] API contract updated (`@Contract` → `pnpm contracts:gen`), both generated files committed; any breaking change acknowledged under `## API breaking changes`
- [ ] Migration follows expand/contract. The RLS checker passes
- [ ] Audit events + outbox events for consequential changes
- [ ] Logs/metrics/traces for new flows. No PII in logs
- [ ] UI: loading/empty/error states, accessible, responsive, printable where relevant
- [ ] Security checklist ([08 §13](08-security.md)) ticked
- [ ] Docs updated (this blueprint, runbooks, ADR if a decision changed)
- [ ] CI green. Reviewed (human + `/code-review`)

## 9. Pilot acceptance (UAT)

For each pilot institution before go-live:
- Replay **one full past semester** (real anonymised data): registrations → scores → approvals → GPA/CGPA. Compare with the institution's official broadsheet: **100% match or an explained, institution-accepted difference**.
- Bursary replays one month of payments with reconciliation.
- Registry generates 20 transcripts and compares them with historical ones.
- Sign-off recorded in `docs/ops/uat/<tenant>.md`.
