# Spec 0025: Phase 1, the platform control plane: slices and decisions

**Status:** **Approved by the owner on 2026-10-28, all as written:** A1 to A14, the extras E1 to E12, and the recommended sizing: **Phase 1 closes at S0 to S8, and S9 to S11 are Phase 1b**, built before Phase 3. Nothing is built from it until Phase 0 is signed off. Each slice then gets its own spec (its detailed decisions, acceptance criteria and tests) before it's built, the same way Phase 0 went.
**Phase:** 1 ([18](../18-roadmap.md)): "Platform control plane (~4 wks)".
**Builds on:**

- [05 §1](../05-modules-and-features.md): the console's feature list and acceptance criteria;
- [08](../08-security.md): T12 (console compromise), §3.2 (MFA for all platform staff), §3.3 (console sessions 15 min idle, 8 h absolute), §12 (security events, incident response);
- [11 §9](../11-frontend-guidelines.md): the console's UI rules (typed confirmation, a reason, the two-person status, an environment banner);
- [02](../02-architecture.md) and [ADR-007](../19-decision-log.md): a separate app, host, cookie and CSP; platform identities never in tenant databases;
- [03 §1](../03-domain-model.md): the platform entities, most of them already in `packages/db/prisma/platform/schema.prisma`;
- [ADR-019](../19-decision-log.md) (BullMQ, built with the provisioning job) and [ADR-027](../19-decision-log.md) (Storybook, before the console's first screen);
- [ADR-030](../19-decision-log.md): everything stays local on the owner's machine;
- [spec 0003](0003-product-entitlements.md) (entitlements), [spec 0018](0018-policy-service.md) (the `PolicyService`), [spec 0020](0020-local-backups-and-shred-ledger.md) (the destruction protocol, which a purge uses).

## Why

Phase 0 built the tenant side and the platform's tables, but nothing to run the platform with. Today a tenant exists only through the seed, a product is entitled only by code, and a suspension, a key destruction or a backup runs only from the owner's terminal. Phase 1 builds the console that does this work with the same discipline as the rest: every action permissioned, step-up where it matters, audited in the same transaction, and destructive actions behind two people.

The console is the platform's highest-value target (T12): whoever controls it controls every tenant. So Phase 1 isn't one build. It's a sequence of vertical slices, each one usable, tested and deployed before the next starts, with identity and audit first, so every later slice is built on an authenticated, audited base.

## What exists today, and what's missing

| | Exists | Missing |
| --- | --- | --- |
| Platform tables | `Tenant`, `Shard`, `TenantDomain`, `PlatformUser`, `PlatformSession`, `PlatformAuditEvent` (hash-chained), `TenantProduct`, the key tables | `PlatformMfaFactor` and recovery codes, `ProvisioningJob` and its steps, `MigrationRun`, `Plan`, `Subscription`, `PlatformAnnouncement`, `PlatformTicket`, an approvals table |
| Tenant lifecycle | the `TenantStatus` enum (REQUESTED → … → PURGED); suspended tenants already get 423 (`tenant.guard.ts`) | no code moves a tenant between states, except the seed and the drill |
| Tenant creation | the seed (`packages/db-ops/src/seed.ts`) and the drill's `createDrillTenant` | a resumable, audited provisioning job |
| Apps | `apps/web`, `apps/api` (HTTP and worker), `apps/migrate` | `apps/console`; a platform API |
| Edge | Caddy with the edge CA; tenant hosts under `*.stack.univarse.localhost` | the console host and its allowlist |
| Images | four signed images (API, web, migrate, PgBouncer) | the console's image, in the release, verify and deploy |

## What the research adds

The docs cover the console's core well. The research below ([sources](#sources)) adds what a control plane for this product needs that the docs don't list yet. Each item is a recommendation; the owner accepts or drops it.

| # | Extra | Why UniVarse needs it | Recommended slice |
| --- | --- | --- | --- |
| E1 | **Platform audit viewer with chain verification** | 05 §17 asks for it on the tenant side; the platform's chain exists and nothing reads it. Viewing it is itself audited. | S3 |
| E2 | **Security events view** | 08 §12 lists the events (login anomalies, lockouts, cross-tenant attempts, privilege grants, mass exports, ClamAV detections), and nothing shows them. | S3 |
| E3 | **Monthly access review** | 14 §9 asks for one monthly. The console lists every staff member, their role, last login and MFA state; the reviewer attests, and the attestation is audited. | S3 |
| E4 | **A generic two-person approval queue** | Purge, key destruction, staff elevation and plan-price changes all need a second person (T12, 05 §1). One engine, not one per action: the approver sees exactly the payload requested, can't be the requester, and approves with step-up. | S6 |
| E5 | **No "log in as user"** | Impersonation is the usual support shortcut, and it breaks attribution and the processor role (16 §1). The only way in is break-glass: read-only, time-boxed, reason-logged and visible to the tenant (05 §1). This makes it a stated non-goal. | (a rule) |
| E6 | **Go-live checklist per tenant** | ONBOARDING → ACTIVE should be a gate, not a click: DPA signed, the IT Admin activated with MFA, products chosen, branding set, demo data absent. AWS's SaaS Lens treats onboarding as a first-class, observable flow. | S5 |
| E7 | **Tenant regulatory profile** | The regulator (NUC, NBTE or NCCE), the accreditation status, the state, and the JAMB institution code `[VERIFY]`. Admissions (CAPS) and statistical returns need them later. | S4 |
| E8 | **NDPA registers** | UniVarse is the processor of tenant data and the controller of platform data (16 §1). GAID 2025 (in force since 2025-09-19) brings registration with the NDPC, a DPO, and an annual compliance audit return (by 31 March for entities established before 12 June 2023) `[VERIFY with counsel]`. The console keeps: each tenant's DPA (version, signed date, DPO contact), the sub-processor register, an incident register with its clocks (the tenant notified within 24 h by contract; the controller notifies the NDPC within 72 h, 08 §12), and an evidence pack for the audit return. | S11 |
| E9 | **Peak-days calendar per tenant** | Registration deadlines and result days are the platform's riskiest days (T11). Knowing them lets a deploy warn about a change freeze, and lets announcements go out ahead. | S11 |
| E10 | **A read-only operations panel** | Backups, the ledger's heads, the latest drill record, the release running and Vault's token expiry are only visible in the owner's terminal today. A worker job writes a non-secret status snapshot into the platform database; the console reads only that, and never mounts the host's `~/.univarse`. | S11 |
| E11 | **A key management view** | Each tenant's data keys (versions, status, rotations, destructions), and destruction requests through the two-person queue. | S11 |
| E12 | **Delivery log per tenant** | 05 §1 says delivery of notices is logged; the console shows it for each tenant, with bounces. | S6 |

## Architecture decisions for approval

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| A1 | **A separate platform API process.** A new entrypoint in `apps/api` (`platform.ts`, next to `main.ts` and `worker.ts`), served only behind the console host at `/api/platform/v1`, as its own container. | The console's blast radius stays separate (ADR-007), and a spike in tenant traffic can't starve it, or the other way round (ADR-020, T19). It reuses the codebase, its config validation, Problem Details, OTel and audit. Alternative: the same process, routed by host. Rejected: one compromise or overload reaches both. |
| A2 | **A new least-privilege database role, `univarse_console`,** with write access only to the platform tables the console owns, and **no tenant database credentials at all.** Anything that writes tenant data (provisioning's seed, a purge, an export) runs as a job in the worker. | The console can't read tenant personal data even if it's compromised (16 §1: UniVarse processes tenant data only on instruction). Alternative: reuse `univarse_app_platform`. Rejected: that role is the tenant API's, and its grants would grow to cover console writes. |
| A3 | **Platform identity reuses the identity domain code, on platform tables.** Argon2id, OTP activation, TOTP and recovery codes, sessions and step-up come from Phase 0's code, parameterised by store. TOTP enrolment is **mandatory before anything else** after the first password. Sessions: `__Host-uv_console_sid`, 15 min idle and 8 h absolute, at most 3 per staff member, rotated at login and step-up. WebAuthn stays Phase 8 (08 §3.2). | One audited implementation, not two. Alternative: a separate identity provider. Rejected: ADR-030 keeps everything local, and a second implementation doubles the attack surface. |
| A4 | **The first OWNER is created by a one-shot CLI job on the stack, run by the owner,** which sends an activation email (Mailpit locally). No sign-up page, ever, and no seeded platform user outside development. Every later staff member is invited by an OWNER from the console. | Nobody can become platform staff by visiting a page. Alternative: a seeded OWNER with a printed password. Rejected: a password in a terminal or a fixture breaks invariant 8. |
| A5 | **Platform permissions in a `platform.*` catalogue, evaluated by a pure `evaluate()` like spec 0018's,** with the five roles mapped to permissions in code. Every platform route declares a permission; the route sweep fails a route that doesn't. Only an OWNER manages roles. | The same discipline as the tenant side (invariant 2). Alternative: role checks in each controller. Rejected: not sweepable. |
| A6 | **The allowlist twice: at the edge and in the app.** Caddy refuses the console host from any address outside the allowlist (locally: loopback and the stack's own networks); the platform API checks the client address again. | Defence in depth (T12): a misconfigured edge alone doesn't open it. Alternative: the edge only. Rejected for that reason. A per-staff allowlist (03 §1's `ipAllowlist`) waits until there's more than one staff member. |
| A7 | **Two people are required for destructive actions, and a solo owner doesn't get a bypass.** While the owner is the only platform staff member, actions needing two people (purge, key destruction) stay where they are today: the owner's CLI protocol (spec 0020). The console offers them once a second staff member exists. | A two-person rule that one person can satisfy is theatre. Alternatives: a second account held by the owner, or a 24 h delay as a substitute. Rejected: both let one person do it alone. |
| A8 | **BullMQ arrives with provisioning, and Postgres stays the system of record** (ADR-019's revisit trigger). `ProvisioningJob` and its step rows record the state; BullMQ only schedules and retries; jobs are enqueued from the platform outbox, in the same transaction as the request. Queues are per product (ADR-020). | A lost Valkey loses no state: the outbox enqueues again, and the steps are idempotent. Alternative: keep polling Postgres. Rejected: provisioning needs resumable steps with retries and priorities, exactly the trigger ADR-019 named. |
| A9 | **Provisioning's steps are named, idempotent and resumable:** reserve the slug and place the shard → create the platform rows (REQUESTED → PROVISIONING) → seed the tenant (roles, the permission catalogue, settings defaults) → create the data key (Vault Transit) → add the subdomain host → set entitlements from the plan → invite the first IT Admin (an activation email through the tenant outbox) → ONBOARDING. A failed step stops the job; resuming starts at the failed step; every step logs and audits. | 05 §1's acceptance criteria, and J1. The seed's existing code becomes the "seed the tenant" step. |
| A10 | **Custom domains wait for hosting.** TXT verification and on-demand TLS need public DNS and a public CA, and ADR-030 keeps everything local. Locally every tenant is `<slug>.stack.univarse.localhost`, under the edge CA's wildcard. | It's an S-priority feature that can't be shown locally. Alternative: build the TXT model now. Rejected: it would be untested against real DNS. Recorded as deferred, with its trigger: the hosting decision. |
| A11 | **The console is a fifth signed image, `univarse-console`,** with its own role in the release record, provenance, verification and the deploy. | The same supply-chain guarantees as the other four (ADR-029). The release tooling, the gates' proofs and `verifyRelease` each learn the new role. |
| A12 | **A purge is a crypto-shred followed by row deletion.** After the export window, the tenant's keys are destroyed through spec 0020's protocol (so the ledger re-applies it after any restore), then its rows are removed. Two people approve it. | A restored backup can't bring a purged tenant back. Alternative: delete rows only. Rejected: every backup set would still hold the data. |
| A13 | **Plans and subscriptions now; invoices and usage later.** A plan names its products and a price per student in kobo (`bigint`); a subscription ties a tenant to a plan and drives its entitlements. Platform invoices wait until there are students to count (Phase 4). | Entitlements need plans now; invoicing an institution with no students has nothing to bill. |
| A14 | **Break-glass is built last in the phase, or deferred.** It's S-priority (05 §1), and a read-only, time-boxed session into a tenant that the tenant can see is a design of its own (its own spec). | It must not be rushed. The owner decides in S9 whether it lands in Phase 1. |

## The slices, in order

Each slice is a vertical slice (contract → migration → domain → use case → controller → UI → tests → docs), gets its own spec first, and closes with green CI, an owner-run release and deploy where an image changes, and the docs updated. "Release" below means a new signed release is needed.

| Slice | What it delivers | Depends on | Release | Exit (its own acceptance) |
| --- | --- | --- | --- | --- |
| **S0. Phase start** | The threat model refreshed (08 §2, new rows for the console: session theft, approval bypass, provisioning abuse, a platform insider); **Storybook** for `packages/ui` with stories for every component and accessibility checks in CI (ADR-027) | Phase 0 signed off | no | Storybook builds in CI; the a11y check fails on a seeded violation (a proof) |
| **S1. The console's shell** | `apps/console` (Next.js 16, its own CSP with nonces, cookie and environment banner "LOCAL"); the platform API process with `/health`; the edge host `console.stack.univarse.localhost` with the allowlist; the `univarse_console` role; the console image in the release | S0 | **yes** | The host answers from loopback and refuses from elsewhere (a test from a non-allowlisted network); 5 images signed and verified; the smoke covers the console |
| **S2. Platform identity** | The owner bootstrap CLI; activation; login; mandatory TOTP enrolment with recovery codes shown once; sessions (list, revoke), lockout, new-device email; step-up; staff invite, deactivate and role change (OWNER only); `platform.*` permissions; every action audited | S1 | **yes** | E2E: login without TOTP is impossible; a deactivated member's sessions die at once; the route sweep covers every platform route; unauthorised → 404 |
| **S3. Seeing what happened** | E1 audit viewer and chain verification; E2 security events; E3 the monthly access review | S2 | yes | Viewing the audit log is audited; a tampered row is detected by the viewer; the review records its attestation |
| **S4. The tenant registry** | Tenant list and detail (status, shard, domains, products, keys read-only); edit the profile; branding (logo through the files module, colours checked for contrast); E7 the regulatory profile; entitlements per tenant (spec 0003's platform side) | S2 | yes | Changing an entitlement makes the product's routes 404 for that tenant within the cache bound (60 s); every change audited |
| **S5. Provisioning** | BullMQ in the worker (A8); `ProvisioningJob` and its steps (A9); create a tenant from the console; watch its steps; resume a failed one; E6 the go-live checklist gating ONBOARDING → ACTIVE | S4 | yes | **J1 E2E:** create → provisioned → the IT Admin activated with MFA in under 10 minutes; a step killed halfway resumes without duplicates; cross-tenant: provisioning tenant B never touches tenant A |
| **S6. Approvals, suspension and notices** | E4 the two-person engine; suspend (with a reason) and resume; platform announcements and maintenance notices to IT Admins (banner and email), targeted or to all; E12 the delivery log | S5 | yes | A suspended tenant's logins get 423 (J10); an approval can't be self-approved, can't be replayed, and executes exactly what was approved; delivery is logged |
| **S7. Offboarding and purge** | Offboarding with the 60-day export window and warning emails at 45/30/14/7/1 days; the full tenant export (an encrypted archive, a short-lived link); archive; purge (A12, two people, A7) | S6 | yes | The export opens and matches the tenant's row counts; a purge leaves the tenant `key_destroyed` after a restore (the drill's check, reused); a purge without two approvals is refused |
| **S8. Shards and migrations** | The shard view; `MigrationRun` per shard with its status; the migrations runner's dashboard | S5 | yes | A failed migration on one shard shows there and blocks nothing else |
| **S9. Support and break-glass** | Platform tickets from IT Admins with SLA timers (14: P1 1 h, P2 4 business hours, P3 1 business day), two-way messages and attachments; the break-glass decision (A14) | S6 | yes | Only IT Admins (and roles they delegate) raise tickets; every message logged on both sides |
| **S10. Plans and subscriptions** | A13: plans, subscriptions, entitlements driven by the plan | S4 | yes | Changing a plan changes entitlements, audited; prices are `bigint` kobo end to end |
| **S11. Compliance and operations** | E8 the NDPA registers; E9 the peak-days calendar; E10 the operations snapshot; E11 the key view | S6 | yes | The incident register shows its clocks; the ops snapshot holds nothing secret (a test); a deploy during a peak day warns |

**Dependencies:** S0 → S1 → S2 → (S3, S4) → S5 → (S6, S8) → (S7, S9, S11); S10 needs only S4.

## Phase 1's exit criteria (proposed)

The roadmap's three, plus what the console's threat model needs:

1. **J1 E2E green:** a tenant is created, provisioned, and its IT Admin activated with MFA, in under 10 minutes (roadmap).
2. **A suspended tenant is blocked with 423** (roadmap; J10).
3. **The console host refuses a non-allowlisted address,** at the edge and in the app (A6).
4. **No console login without TOTP** (E2E), and a deactivated staff member's sessions end at once.
5. **Every platform route declares a permission and audits its writes** (the route sweep, extended).
6. **The console can't read tenant personal data:** `univarse_console` has no grant on any tenant database (a test).
7. **A two-person action can't be approved by its requester** (S6).
8. **Five signed images** released, verified and deployed (A11).

## Sizing, honestly

The roadmap says about 4 weeks. At Phase 0's pace (spec, review, mutation checks, the owner's release for each image change), S0 to S8 is closer to **6 to 8 weeks**, and S9 to S11 another 3 to 4. Two options for the owner:

- **Chosen (the owner, 2026-10-28):** Phase 1 closes at **S0 to S8.** That meets the roadmap's exit criteria and covers the whole tenant lifecycle. **S9 to S11 become "Phase 1b"**, built before Phase 3 (Admissions and Bursary), when the first real institution would need support and compliance in place.
- **Alternative:** all of S0 to S11 in Phase 1, re-estimated at about 10 weeks.

## Deferred, with their triggers

- **Custom domains** (A10): the hosting decision.
- **WebAuthn:** Phase 8 (08 §3.2).
- **Platform invoices and usage:** Phase 4, when there are students to count (A13).
- **A per-staff IP allowlist:** a second platform staff member (A6).
- **Status page** (14): hosting.
- **Break-glass:** decided in S9 (A14).

## The owner's steps

- ~~Approve or change A1 to A14, the extras E1 to E12, and the sizing option.~~ Done: all approved on 2026-10-28, with Phase 1b.
- In S1, S2 and every slice marked "release": run the release and the deploy.
- In S2: run the bootstrap CLI once, to create the OWNER account (A4).
- In S11 `[VERIFY with counsel]`: the NDPA points (registration category, the audit return's deadline, the DPA template).

## Affected docs (in the slices' PRs)

- [18](../18-roadmap.md): Phase 1's build list and exit criteria, and Phase 1b if approved;
- [05 §1](../05-modules-and-features.md): the extras accepted;
- [08](../08-security.md): the threat model rows (S0), and A6 and A7;
- [03 §1](../03-domain-model.md): the new entities and the tenant lifecycle's state machine;
- [02](../02-architecture.md): the platform API process (A1);
- [07](../07-data-and-database.md): the `univarse_console` role (A2);
- [10](../10-infrastructure-and-deployment.md): the console host, the fifth image, the deploy;
- [16](../16-compliance-ndpa.md): the registers (E8);
- [19](../19-decision-log.md): ADRs for A1, A2, A7 and A8 (the new process, the role, the solo-owner rule, BullMQ). ADR-019 and ADR-027 marked as built when their slice lands.

## Out of scope

The tenant-side features of Phase 2 onwards; anything hosted (ADR-030); a public sign-up for institutions (a tenant is requested through UniVarse, then provisioned).

## Sources

The research behind the extras (E1 to E12):

- AWS Well-Architected SaaS Lens: [tenant onboarding](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-onboarding.html), [tenant tiers](https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/tenant-tiers.html), and [onboarding best practices](https://aws.amazon.com/blogs/apn/tenant-onboarding-best-practices-in-saas-with-the-aws-well-architected-saas-lens);
- [Azure Well-Architected, SaaS DevOps](https://learn.microsoft.com/en-us/azure/well-architected/saas/devops): lifecycle management as a control plane duty;
- [A multi-tenant architecture guide](https://hidekazu-konishi.com/entry/aws_saas_multi_tenant_architecture_guide.html) (secondary): keep the control plane off the tenant request path;
- [Microsoft's privileged access module](https://learn.microsoft.com/ro-RO/training/modules/audit-identity-access-management/privileged-access): just-in-time access through Lockbox, scoped, justified, approved and time-limited;
- NDPA and GAID 2025: [DLA Piper](https://privacymatters.dlapiper.com/2025/06/nigeria-ndpc-issues-gaid-key-compliance-insights/), [KPMG's review](https://assets.kpmg.com/content/dam/kpmg/ng/pdf/2025/05/Review%20of%20the%20NDPA%20General%20Application%20and%20Implementation%20Directive%20GAID%202025.pdf), [Mondaq on third-party service providers](https://webiis10.mondaq.com/nigeria/privacy-protection/1691810/legal-obligations-for-third-party-service-providers-under-the-ndpa-and-gaid-2025-in-nigeria). These are commentary, not the GAID's text: every NDPA point is `[VERIFY with counsel]`;
- Regulators: [NCCE's accredited colleges](https://ncce.gov.ng/AccreditedColleges); the NUC and NBTE publish their own directories. The JAMB institution code wasn't found in the research and stays `[VERIFY]`.
