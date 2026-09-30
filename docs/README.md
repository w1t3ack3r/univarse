# UniVarse — Engineering Blueprint

This folder is the **single source of truth** for building UniVarse from scratch to general availability (GA).
Every design decision, rule and standard the codebase must follow lives here. If code and docs disagree, one of them is a bug: fix the code, or change the doc through a decision record ([19-decision-log.md](19-decision-log.md)).

> **Status:** v1.0 draft (2026-09-30). These are living documents. Update them in the same PR as the change they describe.

---

## What UniVarse is (one paragraph)

UniVarse is a **multi-tenant SaaS platform that runs the academic and administrative life of Nigerian tertiary institutions**. It covers admissions (JAMB/Post-UTME), fees and payments (Paystack/Flutterwave/Remita), course registration, examinations, result processing with the HOD → Dean → Senate approval chain, GPA/CGPA and degree classification, clearance, graduation, transcripts, NYSC lists and hostels. One platform serves many institutions. Each institution's data is strictly isolated, and each institution can have its own subdomain or custom domain.

---

## Document map

| # | Document | Read it when… |
|---|----------|---------------|
| — | [00-glossary.md](00-glossary.md) | You meet a Nigerian-academia term (carryover, spillover, CAPS, RRR…) |
| 01 | [01-product-brief.md](01-product-brief.md) | You need the *why*: vision, personas, scope, non-goals, success metrics |
| 02 | [02-architecture.md](02-architecture.md) | You're touching system structure, tenancy, module boundaries, the tech stack |
| 03 | [03-domain-model.md](03-domain-model.md) | You're adding or changing entities, relationships or state machines |
| 04 | [04-business-rules.md](04-business-rules.md) | You're implementing grading, GPA, registration, fees, probation or graduation logic |
| 05 | [05-modules-and-features.md](05-modules-and-features.md) | You're building a feature: scope, actors, acceptance criteria |
| 06 | [06-api-guidelines.md](06-api-guidelines.md) | You're designing or changing an HTTP endpoint |
| 07 | [07-data-and-database.md](07-data-and-database.md) | You're writing a migration, query, index or RLS policy |
| 08 | [08-security.md](08-security.md) | Always. Especially for auth, authorization, uploads, payments, exports |
| 09 | [09-container-security.md](09-container-security.md) | You're writing a Dockerfile, compose file, Helm chart or CI build step |
| 10 | [10-infrastructure-and-deployment.md](10-infrastructure-and-deployment.md) | You're provisioning environments, deploying, backing up or planning DR |
| 11 | [11-frontend-guidelines.md](11-frontend-guidelines.md) | You're building UI in `apps/web` or `apps/console` |
| 12 | [12-testing-strategy.md](12-testing-strategy.md) | You're writing tests or deciding what "done" means |
| 13 | [13-ci-cd-and-workflow.md](13-ci-cd-and-workflow.md) | You're committing, opening PRs, releasing, or changing pipelines |
| 14 | [14-observability-and-operations.md](14-observability-and-operations.md) | You're adding logs, metrics, alerts, or writing a runbook |
| 15 | [15-integrations.md](15-integrations.md) | You're integrating payments, SMS, email, JAMB, WAEC, NYSC… |
| 16 | [16-compliance-ndpa.md](16-compliance-ndpa.md) | You're handling personal data, retention, exports, or a breach |
| 17 | [17-coding-standards.md](17-coding-standards.md) | Always. Conventions for TypeScript, NestJS modules, naming, errors |
| 18 | [18-roadmap.md](18-roadmap.md) | You're planning work: phases, milestones, exit criteria |
| 19 | [19-decision-log.md](19-decision-log.md) | You want to know why something is the way it is, or to propose a change |
| — | [templates/CLAUDE.md](templates/CLAUDE.md) | Copy to the new repo root. It's the operating manual for AI-assisted development |

### Suggested reading order
- **First time:** 01 → 00 → 02 → 03 → 04 → 08 → 18.
- **Before any feature:** the relevant section of 05, the entities in 03, the rules in 04, then 06, 07 and 12.
- **Before any infra work:** 09 → 10 → 14.

---

## Conventions used in these docs

- **MUST / MUST NOT / SHOULD / MAY** follow RFC 2119. A MUST is enforced in review and, wherever possible, by CI.
- **`[CONFIG]`** marks a business rule that varies by institution. It MUST be a tenant setting with a sensible default and never hard-coded.
- **`[VERIFY]`** marks a fact about an external system, regulation or institution practice that must be confirmed with the provider, a lawyer, or the pilot institution's handbook before it's relied on in production.
- **`[PHASE n]`** ties a feature to a roadmap phase in [18-roadmap.md](18-roadmap.md).
- Diagrams use Mermaid, which renders on GitHub, GitLab and VS Code.

---

## Lessons carried over from the v0 prototype

The first attempt (Jan–Feb 2026) produced a wide UI prototype and a partial auth/platform backend. What we keep and what we change:

| Keep | Change |
|------|--------|
| Nigerian domain depth: grading, approval chain, clearance stages, senate list, NYSC | **One language (TypeScript).** Drop the unused Laravel service ([ADR-002](19-decision-log.md)) |
| Role portals for Dean, IT Admin and Super Admin as UX references | **Permission-driven staff workspace** instead of duplicating a portal per role ([02 §6](02-architecture.md)) |
| Tenant lifecycle: suspend → deletion grace period → purge | **Tenant isolation enforced by the database (RLS)**, not by developer discipline. v0 logged users in against a tenant DB but wrote admin data to a shared DB |
| Brand palette `#485550` / `#C0EB6A` / `#F4F6F0` | **HttpOnly session cookies.** No tokens in `localStorage` |
| IT Admin sub-roles (Bursary, Exams, Admissions…) | **Backend-first per module.** No screen merges without its real API. No mock-data fallbacks in production code |
| Super Admin 2FA, sessions, IP allowlist | **Git from day one**, CI gates, secrets never committed, no DB ports exposed publicly |

---

## How to change these docs

1. Small clarifications: edit directly in your PR.
2. A change to a MUST, a technology choice, tenancy, the security model or data retention: add an ADR to [19-decision-log.md](19-decision-log.md) **first**, then update the affected docs.
3. Keep documents consistent. If you rename a concept, grep the whole `docs/` folder.
