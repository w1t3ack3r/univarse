# Spec 0037: Phase 1's S6, approvals, suspension and notices

**Status:** **Approved by the owner on 2026-11-13, all as written:** Q1 to Q16. PR A (the approval engine and the inbox) built, Q-A1 to Q-A10 for approval.
**Phase:** 1, slice **S6** of [spec 0025](0025-phase-1-control-plane.md) (A7, E4, E12, E18, E19, E25).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A5 (platform permissions in code), A7 (two people for destructive actions, and no solo bypass), A8 (BullMQ);
- [spec 0028](0028-console-identity.md): staff, roles, step-up and the console's own mail;
- [spec 0031](0031-seeing-what-happened.md) Q12: the security events' three levels ("S3 shows; S6 tells");
- [spec 0033](0033-tenant-registry.md): the institutions and their entitlements;
- [spec 0034](0034-provisioning.md): the worker's BullMQ queue, the tenant outbox for an IT Admin's email, and the fixed error codes;
- [05 §1](../05-modules-and-features.md) (suspension, notices, rings, incidents, the inbox), [08](../08-security.md) T12, T24, T26, [12](../12-testing-strategy.md) J10, [14](../14-observability-and-operations.md) (incidents and status), [16 §8](../16-compliance-ndpa.md) (breaches).

## Why

S7's purge, S10's price book and every destructive action after them need a second person, and S6 builds that once. The platform also can't yet stop an institution (a security incident, a regulator's order, a contract ended), tell its IT Admins anything (a maintenance window, a release, an outage), or show staff what needs them today without opening every screen. Phase 1's later slices all lean on these: S7 warns before a purge with notices, S9's SLA timers land in the inbox, and S11's incident register reads the incidents.

## What exists today, and what the code showed

- **Suspension is half there.** `TenantStatus` has SUSPENDED and `tenant.suspended_reason` exists. The tenant guard already answers every request on a suspended host with **423** `tenant.suspended`, and the outbox worker already holds a suspended tenant's events. Nothing sets the status: only the seed (`paused-uni`).
- **The web app shows a suspended institution as unknown.** `tenantProfile()` returns null for a 423 as for a 404, so a student sees "not found" instead of "temporarily unavailable".
- **Raising a member to OWNER takes one person today** (`staff.service.ts` `changeRole`), which T24 names as a two-person action.
- **The platform never knows an IT Admin's address** (ADR-035): it lives in the tenant database, encrypted. So email to IT Admins has to go out from the worker, through each tenant's outbox, as S5's invite does.
- **The tenant API reads a few platform columns already** (branding, through column grants to `univarse_app_platform`), so a banner can be read the same way, with no new credential.
- **BullMQ and the worker's queue exist** (spec 0034 Q3). A second queue costs a few lines.
- **Nothing in the code is behind a feature flag,** and there's no flag mechanism.
- **The security events' levels exist** (spec 0031 Q12), with "act" for malware, RLS violations, a broken audit chain and undeclared routes.

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **New permissions** (`packages/domain`, A5), all but the reads with step-up:<br>• `platform.approval.decide`: approve or reject someone else's request. OWNER, SUPER_ADMIN.<br>• `platform.tenant.suspend`: suspend and resume an institution. OWNER, SUPER_ADMIN.<br>• `platform.notice.publish`: write, publish and withdraw notices. OWNER, SUPER_ADMIN, SUPPORT.<br>• `platform.incident.manage`: open, update and resolve incidents. OWNER, SUPER_ADMIN, SUPPORT.<br>• `platform.release.manage`: set an institution's release ring. OWNER, SUPER_ADMIN.<br>Reading notices, incidents and rings is `platform.tenant.read`. Requests are made with the action's own permission (a request to make an OWNER needs `platform.staff.manage`). The inbox is `platform.self`, filtered by what each person can do. | SUPPORT is the role that talks to institutions (14's "comms" role in an incident), so it can publish and run an incident, but not stop an institution or decide an approval. |
| Q2 | **One approval engine (E4), in a table `platform_approval`:** the kind, the payload (a small JSON object, never personal data), the **SHA-256 of its canonical form**, who asked and why (a required reason), the status (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `CANCELLED`, `EXECUTED`, `FAILED`), who decided and when, an expiry, a version. Each kind is declared in `packages/domain`: its payload schema, who may request, who may approve, how long it waits (24 hours by default), and its executor. | One engine, not one per action (E4). Every later two-person action is a new kind, not a new mechanism. |
| Q3 | **The rules, enforced in the use case and by the database:**<br>• **The approver isn't the requester,** and isn't the person the payload names (nobody approves their own promotion).<br>• **The approver holds the kind's approve permission, with step-up.**<br>• **The approver sends back the hash of the payload they were shown;** a different hash is refused (409). The executor runs the stored payload, never a request body.<br>• **Single use:** PENDING → APPROVED → EXECUTED by version check; a second approval, or one after the expiry, is refused.<br>• **Executed in the approval's own transaction** with its audit events, or, for a long job (S7's purge), queued from that transaction.<br>• **The requester can cancel** while it's PENDING.<br>Each step is audited (requested, approved or rejected, executed or failed). | T24, line by line: self-approval, a swapped payload, a replay, a stale approval. Executing in the same transaction means nothing can run between the decision and the action. |
| Q4 | **S6's only kind is `staff.make_owner`:** raising a member to OWNER. `changeRole` to OWNER becomes a request; every other role change stays one person, as today. Purge and key destruction arrive as kinds with S7, price changes with S10. | The engine needs a real, low-risk first use, and T24 names this one. A kind that S6 builds but nothing executes would be untested. |
| Q5 | **No solo bypass (A7).** A request can only be made if someone other than the requester (and the person named) could approve it; otherwise the console says "this needs a second person" and offers nothing else. While the owner is the only OWNER or SUPER_ADMIN, `staff.make_owner` can't be requested. The stack's check (criterion 12) uses a second staff account the owner invites for the test, and removes it after; that's a test of the engine, not a control. | A two-person rule one person can satisfy is theatre (A7). |
| Q6 | **Suspension takes one person, with step-up and a reason from a fixed list:** a security incident, a regulator's order, the contract ended, the institution asked, or other (with a note of up to 200 characters, shown to staff only). **Non-payment isn't a reason:** spec 0030 says unpaid bills hold new admissions and registrations, never sign-in.<br>ACTIVE or ONBOARDING → SUSPENDED; **resume** returns it to the status it had. Both audited, both take effect at once (the tenant cache's invalidation), and the institution's detail shows when, by whom and why. | Suspension is protective and undone with one click, and in an incident it can't wait for a second person. Alternative: two people. Rejected for those reasons; purge, which can't be undone, needs two. |
| Q7 | **A suspension ends every session of the institution.** The worker does it (it holds the tenant credential; the console doesn't, A2) in a job queued from the suspension's transaction. Resuming doesn't bring a session back: everyone signs in again. | A suspension for a security incident must not leave a stolen session waiting for the resume. |
| Q8 | **A suspended institution's addresses say so, plainly.** The web app shows a page, in the institution's branding, with "This institution is temporarily unavailable. Please contact your ICT unit." for a 423, instead of "not found". Background work for it stays held (the outbox, today), **except notices** (Q10), so its IT Admins can be told. | The 423 message exists; the web app hides it. |
| Q9 | **Notices (05 §1) in a table `platform_notice`:** a kind (`ANNOUNCEMENT`, `MAINTENANCE`, `RELEASE_NOTE`), a title (up to 120 characters) and a body (plain text, up to 2,000 characters, links shown as text, never HTML), the audience (every institution, chosen institutions, or a release ring), a window (maintenance: starts and ends; others: shown until withdrawn or for 14 days), and a status: DRAFT → PUBLISHED → WITHDRAWN. **A published notice is never edited:** a correction is a new notice, and the old one is withdrawn. | Plain text means a notice can't carry script into every institution's pages (T34). Never editing means what an institution was told is what the record says. |
| Q10 | **How a notice reaches an institution:**<br>• **A banner in the web app,** read by the tenant API from the platform tables through column grants (as branding is). Maintenance notices show to everyone at the institution, including on its sign-in page; announcements and release notes show to its IT Admins only. A user can dismiss a banner, recorded on the tenant side.<br>• **An email to its IT Admins,** fanned out by the worker in a queue of its own (`platform-notices`): one job per institution, writing an email event per IT Admin into that tenant's outbox. Notice emails are delivered even while it's suspended.<br>The platform never sees an address. | 05 §1: "in-app banner + email". The fan-out runs per institution, so a slow or failing one doesn't hold the others (invariant 11). |
| Q11 | **The delivery log (E12) is counts, per notice and institution** (`platform_notice_delivery`): IT Admins found, emails queued, sent, failed; banners dismissed. The worker updates them from each tenant's outbox; no address, name or user id crosses to the platform. A notice's page shows the table; an institution's detail shows the notices it got. Bounces need a real mail provider: locally, an SMTP failure counts as failed. | "Delivery is logged" (05 §1), within ADR-035: the platform knows how many, never who. |
| Q12 | **Release rings (E18): PILOT or GENERAL, per institution** (`tenant.release_ring`, GENERAL by default), set in the console and shown in the list and the detail. Notices can target a ring, so release notes reach the pilot first. **Feature flags wait for their first feature:** nothing is flagged today, so S6 builds the ring, not a flag engine; the first feature that needs a pilot (Phase 2) brings the flag table, evaluated per ring by a pure function. | A flag engine with no flag is untested code. The ring is what the console needs now: who is in the pilot. |
| Q13 | **Incidents (E19) in `platform_incident`:** a title, a severity (SEV1 to SEV4, 14's levels), the affected institutions (all, or chosen), started at, the status (`INVESTIGATING`, `IDENTIFIED`, `MONITORING`, `RESOLVED`), and two flags for S11's register: **"personal data may be involved"** (yes, no, not yet known) and when we became aware. Each change is a row in `platform_incident_update`, append-only: the time, the status, **public text** (shown to the affected institutions) and an **internal note** (staff only). After resolving: a follow-up (what happened, actions), staff only. | The timeline is the record (14). Splitting public and internal text means staff can write freely without leaking to institutions. |
| Q14 | **An open incident shows at the affected institutions** as a banner to everyone, with its latest public update and status, through the same read as notices; resolved incidents show for 24 hours, then leave. When personal data may be involved, the incident's page shows the 72-hour clock from awareness (16 §8), with no notification sent by the system: the controller is the institution. | E19, "status for institutions". The public status page waits for hosting. |
| Q15 | **The console inbox (E25), computed when read,** for each person by what they can do: approvals waiting for them (not their own), their own requests decided, failed provisioning jobs, "act" security events in the last 24 hours (spec 0031), open incidents, and maintenance starting within 24 hours. A count in the platform bar, refreshed every minute. No inbox table: an item leaves when its cause is resolved. S9 adds SLA timers. | One place to look (E25). Computing from the source means the inbox can't disagree with the screens. |
| Q16 | **No new ADR.** BullMQ is ADR-036's; the engine and the new tables follow 07's rules (platform tables, named-column grants, append-only where Q13 says). One new threat, T34 (below). | |

## New threat

| # | Threat | Vector | Controls |
| --- | --- | --- | --- |
| T34 | **A notice or incident used against the institutions** | A hostile or careless staff member, or a stolen session, publishes script, a phishing link or another institution's details into every institution's pages; a banner meant for one institution shows at another | Plain text only (links shown, not followed in a banner), with length limits; publishing needs step-up and is audited; the audience is resolved on the platform side from the stored notice, and the tenant API returns only what targets its own host's tenant (a cross-tenant test); withdraw takes effect at once. |

## Acceptance criteria

1. Every new route declares its permission, the route sweep covers them, and out of scope is 404.
2. An approval can't be made by its requester or by the person it names, can't be approved with another payload's hash, can't be approved twice or after it expires, and executes exactly the stored payload (spec 0025 S6's exit, T24).
3. With only one person able to approve, `staff.make_owner` can't be requested; making an OWNER otherwise needs an approval, and every other role change still works as before.
4. Suspending an institution answers every tenant request with 423 at once, ends every session (signing in again fails with 423), and holds its background work except notices; resuming restores the previous status, and nobody's old session works (J10's "suspended tenant login blocked").
5. A suspended institution's addresses show the "temporarily unavailable" page, not "not found".
6. A published notice reaches exactly its audience: the banner at each targeted institution and no other (cross-tenant test), an email per IT Admin through each one's outbox, and the delivery log's counts match the emails sent. The platform database holds no address (a test reads every new column).
7. A notice can't carry HTML or script into the web app (a test publishes `<script>` and an `onerror` image and finds them as text).
8. A withdrawn notice leaves every banner at once; a published notice can't be edited.
9. An incident's updates are append-only; its public text shows at the affected institutions only, its internal notes never leave the console.
10. The inbox shows each item only to someone who can act on it, and an item leaves when its cause is resolved.
11. The new console screens and the web app's banners and suspended page pass axe at WCAG 2.2 AA on desktop and phone.
12. Released and deployed; **on the stack, the owner suspends an institution and sees its users locked out, resumes it, publishes a maintenance notice and sees its banner and the IT Admin's email in Mailpit, opens and resolves an incident seen at the institution, and makes a second (test) account an OWNER through an approval.**
13. Mutation checks on the guards: self-approval, the hash check, single use, the expiry, the solo check, the suspension's 423 and its session ending, the notice's audience, the plain-text rendering, and the inbox's permission filter.

## The PRs

| PR | What | Size |
| --- | --- | --- |
| A | The approval engine, `staff.make_owner`, and the inbox (approvals, failed provisioning, security "act" events) | M |
| B | Suspension and resume, the session ending, the web app's suspended page, J10's suspended case | S–M |
| C | Notices, the fan-out, the banners, the delivery log, release rings | L |
| D | Incidents, their updates and their status at the institutions; the inbox's incident and maintenance items | M |

About **two and a half weeks** at S5's pace, the largest slice in Phase 1, as spec 0025 expected.

## The owner's steps

- Approve or change Q1 to Q16.
- After the PRs: the release and the deploy, then the check in criterion 12 (it needs a second staff account, invited for the test and removed after).

## Affected docs

[05 §1](../05-modules-and-features.md) (the rows for suspension, notices, rings, incidents and the inbox, each pointing here), [08](../08-security.md) (T24's controls as built, T34), [12](../12-testing-strategy.md) (J10's suspended case; a journey for a notice's delivery), [14](../14-observability-and-operations.md) (incidents in the console), [03](../03-domain-model.md) (the approval, notice and incident entities and their state machines), [18](../18-roadmap.md) (S6's row).

## Out of scope

- **Purge, key destruction and price changes as approval kinds:** S7 and S10.
- **Feature flags:** with the first flagged feature (Q12).
- **SLA timers in the inbox:** S9. **The incident and breach registers:** S11 (E8).
- **A public status page:** hosting. **SMS for notices:** Phase 3 with messaging (E15).
- **Notices from an institution to its own people:** Student Affairs and Comms (Phase 5).
- **Bounce handling:** with a real mail provider.

## PR A: what was built

**Built:**
- **The rules** (`packages/domain/src/platform/approvals.ts`): the kinds (`staff.make_owner`, Q4), the payload's canonical form, the decision rules in Q3's order, the solo rule (Q5) and the expiry. The new permission `platform.approval.decide` (OWNER, SUPER_ADMIN, with step-up).
- **The table** `platform_approval` (migration `20261113120000_approvals`), with the database holding the rules too: the decider is never the requester or the person named (checks), a decision names who and when, failures are fixed codes, and a trigger lets the request itself never change and its status move forward once, for every role. The console role inserts named columns only and updates only the decision's columns; the tenant API's platform role gets nothing.
- **The platform API:** `GET/POST /approvals`, `GET /approvals/:id`, `POST /approvals/:id/approve` (with the hash), `/reject` and `/cancel`, and `GET /inbox`. A change to OWNER through Staff now answers `staff.owner_needs_approval`, and an invitation as OWNER `staff.owner_by_approval`.
- **The console:** the Inbox tab for everyone, with its count; the Approvals tab for those who can ask or decide; the list (waiting for you, your requests, the rest); one request's page with the reason, the receipt of exactly what will run and its fingerprint, and the decision; the Staff page's role change turning into a request when Owner is chosen. Designed to the console's DESIGN.md, which now describes the receipt and the counts.

**Evidence:**
- **Domain:** 106 tests, with the decision rules, the solo rule, the canonical form (a property test) and every kind's permissions catalogued.
- **Integration** (`approvals.int.spec.ts`, the real platform database through the platform API's HTTP stack): 12 tests. A second member approves the shown hash after a step-up and the payload runs once; the requester, the person named, a swapped hash, a repeat, an expired request, a cancelled one and a rejected one are refused; a changed world fails with a fixed code; a requester demoted since gets nothing done; SUPPORT, FINANCE and READ_ONLY see and decide nothing (404); the grants and the trigger hold for the console role and the tables' owner; the inbox shows each item to the right person and drops it when resolved. The identity tests (19) pass with the OWNER changes.
- **E2E** (`approvals.e2e.ts`, desktop and phone, axe on every screen): an OWNER asks from Staff, a SUPER_ADMIN in a browser of their own finds it in the inbox and approves it after a step-up, and the member becomes an owner; a SUPPORT member has no Approvals tab and an empty inbox. The whole console suite passes (38).
- **Mutations: 17 tried, 17 caught:** in the domain, dropping each of the own-request, names-you, hash, expiry and single-use checks, counting the requester or a member without an authenticator as a second person; in the API, dropping the request's permission check, the hash, the requester's recheck, the visibility rule and the duplicate check, the two OWNER guards on Staff, and the inbox's own-request, security-permission and "act"-level filters.

**Decisions made while building, for approval:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **An invitation can't make an OWNER.** Invite with another role, then ask for an approval. | Otherwise one OWNER could add another alone, the very thing Q4 stops. |
| Q-A2 | **One route makes every request** (`POST /approvals`, declared `platform.self`); the service checks the kind's own request permission with the catalogue's step-up rule, as the guard would. | Each later kind needs its own permission; one route keeps the engine one engine. The route sweep still sees a declaration. |
| Q-A3 | **The requester's right is checked again at approval.** Demoted or removed since, the request fails (`state_conflict`) and nothing runs. | A member who lost a right shouldn't get it used by proxy. |
| Q-A4 | **A request that would change nothing is refused at the asking** (`approval.not_applicable`), and so is a second identical request while one waits. | Nobody spends a second person's attention on a no-op or a duplicate. |
| Q-A5 | **Expiry is read, not run:** a `PENDING` request past its time reads as `EXPIRED` everywhere and can't be decided; no job rewrites it. | Nothing to schedule, and no window where a sweep hasn't run yet. |
| Q-A6 | **Only members with an authenticator count as a possible second person.** | One who hasn't set one up can't sign in to decide. |
| Q-A7 | **Who's told:** every possible approver is emailed when a request is made (the kind only, no details), and the requester when it's decided. The reason stays in the request's row, never in the audit chain (free text); the payload's hash goes in. | People act on what they're told, and the audit chain holds ids only. |
| Q-A8 | **The inbox count sits on the Inbox tab, not the platform bar.** | The bar is drawn before the console knows who's signed in; the tabs are the signed-in header. |
| Q-A9 | **A rejection needs no reason and no hash.** | Rejecting runs nothing; the requester can ask the person who rejected. |
| Q-A10 | **The test clean-up removes a retired test member's requests first** (as the migrator), since a request names its members with a restricting key. | Members are never deleted for real; only the tests' are, and the key must not block that. |
