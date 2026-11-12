# Spec 0034: Phase 1's S5, provisioning

**Status:** **Approved by the owner on 2026-11-12, all as written:** Q1 to Q16. PR A (the backend) built; Q-A1 to Q-A14 for approval.
**Phase:** 1, slice **S5** of [spec 0025](0025-phase-1-control-plane.md) (A8, A9, E6, E13).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A2 (the console holds no tenant credentials), A8 (BullMQ arrives with provisioning; Postgres stays the system of record), A9 (named, idempotent, resumable steps), A10 (custom domains wait for hosting), E6 (the go-live checklist), E13 (institution templates);
- [spec 0033](0033-tenant-registry.md): the institutions, their profile, regulatory profile, branding and entitlements, which this slice creates instead of the seed;
- [spec 0020](0020-local-backups-and-shred-ledger.md) and `provisionTenantKey` (`packages/crypto`): a tenant's data key;
- [spec 0028](0028-console-identity.md) and [ADR-035](../19-decision-log.md): the console's step-up, its own Vault key and its own mail;
- [ADR-019](../19-decision-log.md) (the outbox worker without BullMQ, and its revisit trigger) and [ADR-020](../19-decision-log.md) (runtime roles; a product's failure must not degrade another);
- [05 §1](../05-modules-and-features.md) (provisioning and templates), [12](../12-testing-strategy.md) J1, [11 §9](../11-frontend-guidelines.md), [08](../08-security.md) T12.

## Why

Today an institution exists only if the seed or the shred drill created it. Every later slice needs real ones: S6 suspends them, S7 offboards them, S10 bills them, and Phase 8's goal is a second institution live in 10 working days. Provisioning is also the most powerful thing the platform does: it creates a tenant's rows, its key, its host and its first administrator. It has to be exact, resumable after any failure, and unable to touch another tenant.

## What exists today, and what the code showed

- **The seed already does most of provisioning's tenant-side work,** idempotently (`packages/db-ops/src/seed.ts`): the platform rows, entitlements, the subdomain, the org root and the 18 system roles with their permissions. It also creates demo accounts, which a real institution must never get.
- **`provisionTenantKey`** creates a tenant's data key under the tenant KEK. The shred drill already calls it from the worker's context.
- **`TenantStatus` already has the lifecycle:** REQUESTED → PROVISIONING → ONBOARDING → ACTIVE. The tenant guard serves only ACTIVE and ONBOARDING, so an institution being provisioned can't be reached, and its IT Admin can sign in while it's ONBOARDING.
- **Nothing queues jobs.** The worker polls the tenant outbox (ADR-019). `ioredis` and Valkey are there; BullMQ isn't. The stack's Valkey sets no `maxmemory-policy`, so it runs with Valkey's default, `noeviction`, which BullMQ needs.
- **Templates have little to apply yet.** The only tenant settings are `registration.unitLimits` and `files.storageQuotaBytes`. The NUC grading schemes exist as pure data in `packages/domain/src/results`, but no tenant setting stores a grading scheme or a session structure until Academics (Phase 3).
- **The tenant activation flow is self-service:** a user with an account asks for a code at their institution's address, and it's emailed through the tenant outbox. An IT Admin invite only has to create the account and send the first email.
- **The platform API can't decrypt anything tenant-side, and the worker can't decrypt anything platform-side** (ADR-035). The IT Admin's name and email have to travel from the console to the worker without either rule bending (Q7).

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **New permissions** (`packages/domain`, A5):<br>• `platform.tenant.provision`: create an institution, resume a failed provisioning. OWNER, SUPER_ADMIN, with step-up.<br>• `platform.tenant.go_live`: record the DPA, take an institution live. OWNER, SUPER_ADMIN, with step-up.<br>Reading a provisioning's progress and the checklist is `platform.tenant.read`. | The same group that edits institutions (spec 0033 Q1) creates them; everyone who can see an institution can see where it stands. |
| Q2 | **Provisioning runs in the tenant worker, in a queue of its own, one job at a time.** The worker already holds what the steps need (the tenant shard, the tenant KEK through Vault, the tenant outbox) and already writes platform rows (the security rollups, spec 0031). The console's platform API only records the request. | A2 holds: the console never gets a tenant credential. Alternative: a new `provisioner` runtime role and container. Rejected for now: a tenth container on an 8 GB machine for a job that runs a few times a year. One job at a time, its own queue and its own timeouts keep a stuck provisioning from slowing the outbox. |
| Q3 | **BullMQ, as A8 says, with Postgres as the system of record.** The `provisioning_job` row is its own outbox: the platform API writes it in the same transaction as the tenant row and the audit event. A relay in the worker enqueues every job that should be running, with the BullMQ job id equal to the row's id, so enqueuing twice is harmless. BullMQ only schedules and retries; the rows hold every state. The stack pins Valkey's `maxmemory-policy noeviction`, which BullMQ requires. | A lost Valkey loses nothing: the relay enqueues again, and the steps are idempotent. This is ADR-019's revisit trigger, and S6's announcements (a fan-out to every IT Admin) are the next job, so the queue is built once, here. Alternative: keep polling Postgres. Rejected: A8, approved, and S6 needs the queue anyway. A new ADR records it (Q16). |
| Q4 | **Two platform tables.** `provisioning_job`: the tenant, the template and its version, the status (`QUEUED`, `RUNNING`, `FAILED`, `DONE`), who asked, the encrypted invite (Q7), timestamps, a version. `provisioning_step`: one row per step, its status, attempts, start and end, and a **fixed error code** (never a message or a stack, never personal data). The console role inserts jobs and reads both; only the worker's role updates them. | Each step's state survives any crash. A fixed code means nothing a database driver says can leak to the console. |
| Q5 | **The steps (A9, as the code allows):**<br>0. **In the console's request,** one transaction: check the slug (format, the reserved names, unused), create the tenant (REQUESTED) with its profile and regulatory profile, create the job (QUEUED) holding the template and the chosen products, audit.<br>1. **Place:** the active pool shard with the fewest tenants; REQUESTED → PROVISIONING.<br>2. **Key:** the tenant's data key (`provisionTenantKey`, skipped if one exists).<br>3. **Seed:** the org root and the system roles, from the seed's code, moved into a shared `seedTenantBase()` that the seed calls too. **Never demo accounts.**<br>4. **Template:** the template's settings (Q6).<br>5. **Host:** `<slug>.<domain>` as a verified subdomain.<br>6. **Products:** the chosen entitlements; core enabled.<br>7. **Invite:** the IT Admin's account, the INSTITUTION_ADMIN role, and the activation email through the tenant outbox, in one tenant transaction; the invite is wiped from the job in the same step.<br>8. **Done:** PROVISIONING → ONBOARDING.<br>Every step is idempotent on natural keys, is audited (platform audit; tenant-side writes also in the tenant's audit), and runs through `ShardRegistry.tx` for its own tenant only. | The order makes each failure safe: nothing reaches the tenant until step 5 gives it a host, and nobody is invited until everything else is in place. |
| Q6 | **Templates (E13) are versioned data in `packages/domain`:** `university@1`, `polytechnic@1`, `college-of-education@1`. The institution's type proposes one; the console shows it and lets it be changed. **S5 applies only what exists:** the settings that exist today. The tenant records its template and version (a new column), so each later phase that adds a setting (grading schemes, session structure, carry-over rules) gives that setting a default per template, and a migration applies it to the institutions already provisioned. The polytechnic and college-of-education grading values are `[VERIFY]` with a registrar before Academics uses them. | "Institution differences are settings" (invariant 4), and a template that seeds settings nobody reads yet would be untested. Alternative: build grading settings now. Rejected: that's Academics' work, and its own spec. |
| Q7 | **The IT Admin's name, email and username go from the console to the worker encrypted with a new Vault Transit key, `univarse-provisioning`.** The platform API's token may only **encrypt** with it; the worker's token may only **decrypt**. The ciphertext is bound to the job, and step 7 wipes it. The console shows the email masked (`n•••@unilag.edu.ng`) after creation. | Neither process gains the other's secrets (ADR-035), and the platform database never holds a readable personal detail, even while a failed job waits days to be resumed. Alternative: a plain column the console can insert but not read, wiped at step 7. Rejected: readable in the database and in every backup until then. |
| Q8 | **A failure stops the job; resuming starts at the failed step.** Each step retries up to 3 times with backoff (a Vault or database blip), then the job is FAILED, with the step and its fixed code shown in plain words. **Resume** (`platform.tenant.provision`, step-up) re-queues it; finished steps are skipped. **No "discard" in S5:** a provisioned institution that never goes live is removed by S7's purge (two people, crypto-shred); until then it stays where it stopped, unreachable before step 5. | Removing a tenant is S7's protocol, not a button here. |
| Q9 | **The go-live checklist (E6) gates ONBOARDING → ACTIVE.** Every item is computed, never ticked, except the DPA:<br>• **The IT Admin has activated and set up an authenticator.** The worker reports it as a fact with no personal data: a tenant outbox event when the first INSTITUTION_ADMIN enrols MFA, recorded on the platform side as `admin_ready_at`.<br>• **Products:** at least one product beyond core is entitled.<br>• **Branding:** a colour is set (a logo is optional).<br>• **Regulatory profile:** the state is set, and the operating status isn't UNKNOWN.<br>• **DPA recorded** (Q10).<br>**Go live** is enabled only when every item passes; it needs `platform.tenant.go_live` and step-up, and it's audited. | A gate, not a click (E6). "Demo data absent" isn't an item: provisioning never creates any, and a test asserts it. "Staff trained in the sandbox" joins with E17 in Phase 2. |
| Q10 | **The DPA is recorded by hand until S11's registers:** the version, the date signed, and a reference (the document's name or number), in a `tenant_dpa` table that S11 extends. `platform.tenant.go_live`, with step-up. | NDPA (16 §1): an institution can't go live before UniVarse is its processor on paper. S11 builds the full register on this table. |
| Q11 | **Shard placement:** the active `POOL` shard with the fewest tenants. A `DEDICATED` tier waits for hosting (A10). | One pool exists locally; the rule is right for several, and tested with two. |
| Q12 | **Creating is idempotent:** the request takes an `Idempotency-Key` (docs/06), and a repeated key returns the first answer. The slug's uniqueness is the second guard. | A double click or a retried request never makes two institutions. |
| Q13 | **The console's screens:**<br>• **New institution** (a button on Institutions, for those with the permission): the names, slug, type, ownership, template (proposed by the type), products, state, and the IT Admin's name, email and username. A preview names the address and says what happens next.<br>• **Provisioning:** the steps with their states, refreshed every 2 seconds while it runs; the failed step's plain explanation and **Resume**.<br>• **Go live:** on the institution's page while it's ONBOARDING: the checklist, each item with a link to fix it, the DPA form, and **Go live**. | Spec 0033's patterns and [the console's design context](../../apps/console/DESIGN.md). Polling, not websockets: the console's CSP allows `connect-src 'self'` only, and a provisioning takes about a minute. |
| Q14 | **Cross-tenant proof:** the integration test provisions institution B beside a populated A, and compares a digest of every A row (platform and tenant side) before and after: unchanged. A step given another tenant's id is refused. | Spec 0025's exit criterion, and invariant 1. |
| Q15 | **The J1 journey (E2E, [12](../12-testing-strategy.md)):** create from the console → provisioned → the IT Admin activates and sets up an authenticator → the checklist passes → go live, under 10 minutes on the dev chain. **Resume:** a job killed during the seed step resumes without a duplicate role, key, host or email. | Spec 0025's S5 row, as written. |
| Q16 | **ADR-036:** BullMQ arrives in the worker, with Postgres as the system of record (closes ADR-019's deferral), and the provisioning key's encrypt-only and decrypt-only split. **Three PRs:** **A** the backend (tables, the queue, the steps, the API, the key, the tests); **B** the console screens and the go-live checklist; **C** the stack (the Vault key and its policies, `noeviction`, the deploy's upgrade of an existing Vault). The owner releases and deploys once, after C. | A is reviewable on its own; the stack's Vault change is isolated and proven by the release. |

## New threat

| ID | Threat | Example | Controls |
| --- | --- | --- | --- |
| T33 | **Provisioning crosses tenants or invites the wrong person** | A bug, a replayed job or a hostile console member makes a step write into another tenant, or sends an institution's administrator invite to an address they control | Every step runs through `ShardRegistry.tx` for the job's own tenant; the job id is the queue's id; the invite is encrypted for the worker only (Q7) and wiped; creation needs step-up and is audited with the masked email; the IT Admin's activation needs their own code and authenticator; the cross-tenant digest test (Q14) |

## Acceptance criteria

1. Only OWNER and SUPER_ADMIN, with step-up, can create an institution, resume a provisioning, record a DPA or take an institution live; the route sweep covers every new route; out of scope is 404.
2. Creating writes the tenant, the job and the audit event in one transaction; a repeated `Idempotency-Key` returns the first answer; a reserved, malformed or used slug is refused with a fixed problem code.
3. The worker runs the eight steps in order; each is idempotent (run twice, nothing changes) and audited; a finished job leaves the institution ONBOARDING, reachable at its address, with its key, roles, template settings and products, and **no demo accounts**.
4. The IT Admin receives one activation email; the job's encrypted invite is wiped; the platform database never holds the address in a readable form (a test reads every column).
5. The platform API's token can encrypt but not decrypt with `univarse-provisioning`; the worker's can decrypt but not encrypt (tests against Vault, and in the stack's smoke).
6. A step failure leaves the job FAILED with a fixed code; resume restarts at that step; killing the worker mid-step and resuming makes no duplicate role, key, host or email.
7. A lost Valkey loses no job: with Valkey restarted empty, the relay enqueues every QUEUED or RUNNING job again.
8. Provisioning B leaves every row of A unchanged (Q14), and a step can't be pointed at another tenant.
9. The go-live checklist computes each item; Go live is refused (409, with the failing items) until all pass, then moves ONBOARDING → ACTIVE, audited.
10. The console's three screens work on desktop and phone, with axe clean at WCAG 2.2 AA, and the J1 E2E passes in under 10 minutes.
11. Mutation checks on the guards: the slug checks, the tenant scope of each step, the invite's wipe, the key's split, the checklist's items and the idempotency key.
12. Released and deployed; **the owner creates a real-looking institution on the stack, its IT Admin activates from Mailpit, and the owner takes it live.**

## The owner's steps

- Approve or change Q1 to Q16.
- Check the polytechnic and college-of-education grading values (Q6) with a registrar when you can. It doesn't block S5.
- After the PRs: the release and the deploy, then the check in criterion 12.

## Affected docs

In this PR: [18](../18-roadmap.md). In the implementation PRs: [03](../03-domain-model.md) (`ProvisioningJob`, `ProvisioningStep`, `TenantDpa`, the template column), [05 §1](../05-modules-and-features.md), [06](../06-api-guidelines.md) (the new routes), [07](../07-data-and-database.md) (grants), [08](../08-security.md) (T33, the new key), [10](../10-infrastructure-and-deployment.md) (the queue, Valkey's policy, the key), [12](../12-testing-strategy.md) (J1), [19](../19-decision-log.md) (ADR-036; ADR-019 closed).

## Out of scope

- **Removing an institution** (S7's offboarding and purge).
- **Custom domains** (A10, the hosting decision) and **dedicated shards**.
- **Plans** driving entitlements (S10); products are chosen by hand here.
- **Grading schemes, session structure and carry-over rules as settings** (Academics, Phase 3; Q6).
- **The training sandbox** (E17, Phase 2).
- **The NDPA registers** beyond the DPA record (S11).

## PR A: what was built

**Built:**
- **Domain** (`packages/domain/src/platform/provisioning.ts`): the slug rule, the eight steps and their order, the fixed error codes, the three templates (`university@1`, `polytechnic@1`, `college-of-education@1`), the go-live checklist and the masked email; the two permissions.
- **Database:** `provisioning_job`, `provisioning_step`, `tenant_dpa`, `tenant_onboarding` and `tenant.template`, with checks that keep error codes to the fixed list and a finished job free of its invite; grants by column for the console and the worker.
- **The invite's envelope** (`packages/crypto`, `sealInvite` and `openInvite`): a fresh key wraps the details with AES-256-GCM, the provisioning key wraps that key, both bound to the institution.
- **The console's side** (`apps/api/src/platform/provisioning`): create (202, `Idempotency-Key`), the provisioning view, resume, the checklist, the DPA and go live.
- **The worker's side** (`apps/api/src/modules/provisioning`): the runner and its eight steps, the BullMQ queue and its relay, and the onboarding check.
- **Shared:** the seed's tenant base moved into `seedTenantBase()` (`packages/db`), and the system roles into `packages/contracts`, so the seed and provisioning start an institution the same way.
- **Settings:** the provisioning key on both sides (worker-only for the decrypting side), `TENANT_DOMAIN`, `TENANT_LINK_ORIGIN`, and `db:setup` writing one local development key to `.env.console` and `.env.worker`.
- **Docs:** 03, 05, 06, 07, 08 (T33), 10, 12 and 19 (ADR-036; ADR-019 superseded for new jobs).

**Evidence:**
- **Integration** (`provisioning.int.spec.ts`, 14 tests, real Postgres, Vault and Valkey):
  - who may create, and the idempotency key;
  - the slug's three refusals, and an unknown product;
  - 503 and nothing written without the key, while a replay is still answered;
  - the request's single transaction, and an invite the console role can't select;
  - the eight steps end to end, with no demo account;
  - every step run again after a simulated kill (the invite step's included, after its email committed): no duplicate role, key, host or email, and a setting the institution changed since is kept;
  - a tenant in the wrong status, before the first step or mid-way, stops the job before anything is written;
  - a failure, then resume;
  - demo-uni's and test-poly's digests unchanged after provisioning another;
  - a host held by another institution stops the job;
  - the relay after an emptied queue, and the consumer running the job;
  - the whole go-live checklist, the DPA, the onboarding check and going live.
- **Unit:** the domain's rules (5), the envelope (2), the settings on both sides (5); the audit-label scan names all 11 new actions.
- **Checks:** lint and typecheck on every touched package; `pnpm rls:check` passes.
- **The rest of the integration suite** (557 tests, run serially; the file-scan tests with ClamAV started, then stopped): passes. Updated to match this slice: the console role's exact grants (with the new checks that it can't insert a tenant's `status`, `tier` or `version`, or read the invite), and `.env.worker`'s keys. Found and fixed: the audit metadata recorded the template as `polytechnic@1`, and the "no email in the audit" check rightly flags any `@`; it's now the template and its version as two fields. The rows written before the fix stay in the development database (the chain is append-only); CI's is fresh.
- **Mutations: 17 tried, 16 caught.** The first run left five survivors; four were gaps in the tests, now closed: an invite step re-run after its email committed, a setting changed after provisioning, a tenant suspended mid-way, and a replay while the key is off. The survivor left is equivalent: resume's status check is repeated by its guarded update, and both stay.
- **Development database:** `backup-checks.int.spec.ts`'s `verify-chains` and `verify-unwrap` now take 31 and 40 s locally, over their 30 s timeout: the database holds about 1 380 tenants, 1 339 of them left OFFBOARDING by older suites. They pass with a longer timeout, and on CI's fresh database.

**Decisions made while building, for approval:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **The shard is chosen in the console's request,** not at the "place" step: a tenant row needs its shard. "Place" checks the shard answers before anything is written to it, then moves REQUESTED → PROVISIONING. | The same rule (Q11), at the only point it can apply; nothing reaches the shard before it's proven reachable. |
| Q-A2 | **The console inserts the tenant and the job as named columns,** in a parameterised statement: `status`, `tier` and `version` are the database's defaults, and the console role holds no `INSERT` on them. | The console can only ever create an institution REQUESTED, with a job QUEUED. Prisma's insert would have named those columns, and granting them would have let the console create an ACTIVE institution. |
| Q-A3 | **The idempotency key lives on the job,** unique per member and kept for good (not 24 hours); a replay answers the first ids, with `Idempotent-Replayed: true`. Another member's same key is their own request. | Nothing else needs a stored response here, and a provisioning is never retried a day later by accident. |
| Q-A4 | **The template step writes a setting only if the institution has no row for it,** and records the template on the tenant at creation. | A re-run never overwrites a setting the institution changed afterwards. |
| Q-A5 | **The invite email carries no code:** it names the account and links to the institution's activation page, where the administrator asks for their own code. | Codes last 15 minutes; an invite may be read days later. The activation flow is unchanged, and the address is proven by the code. |
| Q-A6 | **"The administrator is ready" is found by the worker,** every minute, for each onboarding institution: an active INSTITUTION_ADMIN with a confirmed authenticator, recorded once with no personal data. | No tenant-side code changes, and nothing personal crosses to the platform database. A minute's delay on a checklist is fine. |
| Q-A7 | **The worker writes platform rows as `univarse_app_platform`,** the role it already uses, with grants by column on the new tables. | A dedicated provisioning role would need the stack, PgBouncer and the backups changed for one job; recorded for S7, whose purge needs a stronger separation. |
| Q-A8 | **Provisioning is optional per process:** without its key the worker logs that it's off and creating answers 503; nothing else changes. | Existing development setups and the stack keep working until they get the key (your main checkout: `pnpm db:setup`, which keeps every existing secret; the stack: PR C). |
| Q-A9 | **A step retries twice in place** (after 0.5 s and 2 s) for a Vault or database blip, then the job fails; BullMQ never retries on its own. | The rows decide every state, so retries are counted there, where the console shows them. |
| Q-A10 | **The username is stored upper-case and the email lower-case,** as sign-in normalises them; the username is 3 to 40 of `A–Z 0–9 / . _ -`. | The administrator signs in with exactly what the console entered. |
| Q-A11 | **The tests' institutions are archived, and their hosts released, at the end;** their tenant-side rows stay. | The tenant audit chain is append-only, and archived institutions are skipped by every loop. |
| Q-A12 | **The institution's detail gains `template`.** | PR B shows it. |
| Q-A13 | **BullMQ's optional native accelerator stays unbuilt** (`msgpackr-extract`'s install script isn't allowed to run); BullMQ uses its JavaScript path. | No new install scripts (docs/09 §1); a provisioning is a handful of small messages. |
| Q-A14 | **The invite is bound to the institution's id,** not the job's: the id is chosen before either row is written, and there's one job per institution. | Sealing happens before the transaction, so no Vault call holds it open. |

