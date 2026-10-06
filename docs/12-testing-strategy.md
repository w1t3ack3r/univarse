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
| Integration | Vitest + **Testcontainers** (Postgres 18, Valkey, MinIO) | Repositories, use cases with the real DB + RLS, migrations, outbox, job processors | Every PR |
| Contract | OpenAPI diff (oasdiff) + schema tests | Breaking API changes, event schema compatibility | Every PR |
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
| 3. API | ✅ **Complete for today's routes** ([spec 0009](specs/0009-api-route-sweep.md)). The route table is captured from Fastify `onRoute` and cross-checked against Nest; every route is declared, and an unknown route fails the build. For each of the 24 routes, the legitimate operation succeeds first (RS0), then the sweep checks tenant hints (RS3), credentials by kind including the exact M8 allow-list (RS2), collections (RS4), keyed items (RS5), and account actions with the same username in both tenants plus a second user (RS7). Two synthetic leaks are detected on every run (RS8). **Real resource-by-id routes: N/A, 0 routes** | `apps/api/src/route-sweep.int.spec.ts` (+ the earlier hand-written cases) | RS6 for the first resource-by-id routes (Phase 1–2): the sweep refuses to pass without their declarations |
| 4. Jobs | ✅ for the outbox worker: a pass for tenant A never claims B's events, and B's rows are invisible under A's context (live RLS). Inactive products' events wait | `apps/api/src/shared/outbox/outbox.int.spec.ts` (B8, B10) | Repeat for each new job type |
| 5. Caches / files | 🟡 Rate-limit keys are tenant-prefixed. No file storage yet | `shared/infra/rate-limiter.ts` | Presigned-URL and cache-key tests with the files module |

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
- [ ] API contract updated (zod → OpenAPI), client regenerated, no unintended breaking diff
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
