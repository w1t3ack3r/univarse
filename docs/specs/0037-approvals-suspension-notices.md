# Spec 0037: Phase 1's S6, approvals, suspension and notices

**Status:** **Approved by the owner on 2026-11-13, all as written:** Q1 to Q16. PR A (the approval engine and the inbox) built; Q-A1 to Q-A10 approved on 2026-11-13.
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

**Decisions made while building, approved by the owner on 2026-11-13:**

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

## PR B: what was built

**Built:**
- **The rules** (`packages/domain/src/platform/suspension.ts`): the fixed reasons (non-payment isn't one), which statuses can be suspended (ACTIVE, ONBOARDING) and resumed to, the note's rule (required for Other, 3 to 200 characters), and the resume's refusal while sessions are still being ended. The new permission `platform.tenant.suspend` (OWNER, SUPER_ADMIN, with step-up).
- **The table** `platform_tenant_suspension` (migration `20261114120000_suspension`): one row per suspension, with the reason, the staff-only note, the status it had, who and when, then who resumed it and when, and when the worker ended its sessions and how many. The database holds the rules too: the fixed reasons, the note's length, one open suspension per institution (a partial unique index), no resume before the sessions are ended (a check), and a trigger that keeps the record unchanged and writes a resume and the session ending once each. The console role inserts named columns and updates only the resume's; the worker's role reads the ids and times and writes only the session ending.
- **The platform API:** `POST /tenants/:id/suspend` (a reason, and a note when needed) and `POST /tenants/:id/resume`, both `platform.tenant.suspend`; the detail now carries the institution's last 10 suspensions. Both are audited (`platform.tenant.suspended`, `platform.tenant.resumed`), and the status change reaches every API instance through the tenant row's existing invalidation capture.
- **The worker** (`SuspensionSessionEnding`, every 2 seconds): for each suspension whose sessions aren't ended, it ends every session and pending MFA challenge at the institution, audits that on the tenant side (`auth.sessions.ended_by_suspension`, a SYSTEM actor) and on the platform's (`platform.tenant.sessions_ended`), and records it. One institution's failure doesn't hold the others; running twice ends nothing more.
- **The tenant API:** the 423 `tenant.suspended` now carries `institution`, the institution's public name and colours.
- **The web app:** a suspended institution's sign-in pages show "Temporarily unavailable" with the fixed message, in its name and colours, instead of "not found"; its workspace sends visitors there, not to the error page.
- **The console:** a suspended institution's page leads with the suspension (why, since when and by whom, whether the sessions are ended yet, the staff-only note) and Resume; otherwise suspending sits with the other changes, with the fixed reasons and exactly what will happen. Earlier suspensions are listed. Designed to the console's and the web app's DESIGN.md, which now describe both.

**Evidence:**
- **Domain:** 111 tests (5 new): the statuses, the fixed reasons with no non-payment, the note's rule, the resume's wait, and the permission's holders and step-up.
- **Integration** (`suspension.int.spec.ts`, the real databases: the console through the platform API's HTTP stack, the tenant API, and the worker's pass): 6 tests. SUPPORT, FINANCE and READ_ONLY find no route (404), and a session without a step-up is asked for one. Non-payment and a missing note are refused. Only a live or onboarding institution is suspended, once. End to end (J10): a student's session works, the institution is suspended, every request is 423 with its name and colours, and signing in fails. Resume is refused until the worker has ended the sessions, which it audits on both sides and does once. After the resume the old session is 401 and a new sign-in works. An onboarding institution returns to onboarding, and the history keeps each suspension. The database's trigger, checks and unique index hold even for the tables' owner. The console role's grants pin (`platform.int.spec.ts`) includes the table and its column rules.
- **Web unit:** 3 tests for reading the 423 defensively: any other code, a bad name or a colour that isn't `#RRGGBB` means no branding.
- **E2E**, desktop and phone, with axe on every screen:
  - `suspension.e2e.ts` (console, 4): an OWNER suspends with a reason after a step-up, sees the sessions ended, and resumes; SUPPORT sees the history and no action.
  - `suspended.e2e.ts` (web, 6): `paused-uni`'s sign-in, workspace and reset pages show "Temporarily unavailable", and another institution signs in as usual.
  - The whole console suite passes (42), after an Access lead that repeated "is live." was reworded.
- **Mutations: 12 tried, 12 caught.**
  - In the domain: suspending from any status, Other without a note, resuming before the sessions end.
  - In the web app: accepting any colour.
  - In the API: the suspend route needing only read, the service ignoring the session wait, resuming always to ACTIVE, skipping the note rule, the guard serving a suspended institution, the 423 without its institution, the worker ending no session, and the note leaking into the audit chain.

**Decisions made while building, approved by the owner on 2026-11-14:**

| # | Decision | Why |
| --- | --- | --- |
| Q-B1 | **The suspension's row is the worker's job,** found by a 2-second poll (like the onboarding check), not a BullMQ queue. | Q7's "a job queued from the suspension's transaction": the row is written in that transaction. Postgres holds the state either way; a queue would add a second place for it and nothing else. |
| Q-B2 | **Resume waits until the sessions are ended** (409 `tenant.sessions_ending`, and a database check). If the worker is down, resume waits too; the console says why. | Otherwise a session stolen before a security incident's suspension would work again the moment it was resumed (Q7's point). |
| Q-B3 | **The 423 carries the institution's public name and colours**, an optional `institution` member of the problem body; the page shows no logo. | Q8 asks for the institution's branding, and every request there is 423 (criterion 4), including the profile and the logo. Its name and colour are what its sign-in page showed anyone. Alternative: let the profile and logo through while suspended. Rejected: it would break "every tenant request is 423". |
| Q-B4 | **The worker also cancels pending MFA challenges,** and the ending is audited on both sides. | A half-finished sign-in mustn't complete after the resume. |
| Q-B5 | **The note stays on the suspension's row, out of the audit chain** (which records only that there is one). | Free text, as Q-A7: the chain holds ids and choices. |
| Q-B6 | **The worker's grants are on `univarse_app_platform`,** the role it already shares with the tenant API: read the ids and times, write only the session ending. | As provisioning's job (spec 0034). A role of the worker's own would be a separate change. |
| Q-B7 | **Suspending asks for no typed confirmation,** unlike the destructive actions in the console's PRODUCT.md. | It's undone with one click, and in an incident speed matters (Q6). A reason and a step-up are still required. |
| Q-B8 | **An institution suspended without a row** (the seed's `paused-uni`) resumes to ACTIVE. | It has no recorded earlier status, and the seed made it from ACTIVE. |
| Q-B9 | **The test clean-ups remove test suspensions first** (a test member's, and the e2e and `susp-` institutions'), as the migrator. | A suspension names its members and its institution with restricting keys. |

## PR C: what was built

**Built:**
- **The rules** (`packages/domain/src/platform/notices.ts`):
  - what a notice must hold to be published (lengths; no control characters or bidirectional overrides; a one-line title; its audience; a maintenance window, in the future and at most a week);
  - how long its banner shows;
  - who sees it (maintenance: everyone; the rest: IT Admins);
  - which institutions an audience reaches.
  - Two new permissions: `platform.notice.publish` (OWNER, SUPER_ADMIN, SUPPORT) and `platform.release.manage` (OWNER, SUPER_ADMIN), both with step-up.
- **The tables:**
  - `platform_notice`, and `platform_notice_delivery` (one row per institution a published notice reaches), in migrations `20261115120000_notices` and `20261116120000_notice_delivery_log`.
  - `tenant.release_ring`.
  - On the tenant side, `notice_dismissal` and `outbox_event.notice_id`.
  - The database holds the rules too: lengths; a published notice never changes and its status moves forward once (a trigger); its audience never moves; a delivery is withdrawn and fanned out once.
  - The console role writes named columns only. The tenant API and the worker read the columns they need and write only the delivery log's.
- **The platform API:**
  - `GET/POST /notices`;
  - `GET/PUT /notices/:id` (a draft, with `If-Match`);
  - `POST /notices/:id/publish` (with `If-Match`) and `/withdraw` (which also discards a draft);
  - `PUT /tenants/:id/ring`.
  - The institution's detail carries its ring and the notices it got.
- **The tenant API:**
  - `GET /api/v1/tenant/notices` (public: maintenance);
  - `GET /api/v1/notices` (signed in: maintenance, and the rest for IT Admins, without what the person dismissed);
  - `POST /api/v1/notices/:id/dismiss`.
  - Banners are read from the platform tables through column grants and kept per institution for the tenant cache's bound. The cache empties when a delivery arrives or is withdrawn: its capture trigger fires on those alone, so a recount doesn't empty it.
- **The worker:**
  - **Fan-out** (queue `platform-notices`, one job per delivery, as provisioning's relay does): one email per IT Admin with an address, written into that institution's outbox and named by the notice. Run again, it finds the emails there and adds none.
  - **Counting pass:** emails sent and failed, and banners dismissed, for two weeks.
  - **Suspended institutions:** their outbox sends notice emails and holds everything else (Q8).
- **The web app:** the banners, on the sign-in pages (maintenance) and in the workspace (dismissible), as text only.
- **The console:**
  - A Notices tab: Showing now, Drafts, Ended or withdrawn.
  - The editor, with the banner previewed exactly as an institution sees it.
  - A published notice's record: the institutions it reached, the delivery log, and Withdraw.
  - On the institution's page, its ring and the notices it got; the list shows the ring.
- **The capture gate** (`pnpm rls:check`) now covers the delivery's two triggers (13 in all). Its message counts its list instead of saying a fixed "11", which was already stale.

**Evidence:**
- **Domain:** 120 tests (9 new): the publishing rules (markup is text; control characters, bidirectional overrides and line breaks in a title refused), the windows, who sees a banner, which institutions an audience reaches, and the two permissions.
- **Integration**, against the real databases:
  - `notices.int.spec.ts` (9): who may write and set a ring; an announcement only at the chosen institution and only to its IT Admins; maintenance to everyone there and nowhere else; a ring's audience as it was when published (suspended in, archived out); dismissing for oneself only (404 otherwise); a published notice refusing edits and a second publish; withdrawal emptying every banner and telling the institution's cache; `If-Match` and the rules again at publishing; the database's trigger and checks; the institution's detail.
  - `notice-fan-out.int.spec.ts` (7): one email per IT Admin with an address, once; a re-run after a crash adding none; nobody emailed about a notice withdrawn first; a suspended institution's outbox sending the notice and holding the rest; the counts (sent, failed, dismissed); every delivery-log column an id, a count or a time; a recount not emptying the caches.
  - The route sweep declares the three tenant routes, with a test that B's notice answers from A like an unknown id. The grants pin and the identity pin (SUPPORT's new permission) are updated.
- **E2E**, desktop and phone, axe on every screen:
  - `notices.e2e.ts` in the web app (8): maintenance on the sign-in page as plain text, running nothing; nothing at another institution; an IT Admin sees both kinds and dismisses one for themselves; a student sees maintenance only.
  - `notices.e2e.ts` in the console (4): SUPPORT writes, previews, saves, publishes and withdraws; an OWNER sets the pilot ring.
  - The whole console suite passes (46); the web suites except documents (which need ClamAV) pass (60, one first-test flake passed on its rerun).
- **Mutations: 15 tried, 15 caught:**
  - in the domain: everyone seeing every banner; an audience reaching every status; control characters in a title; maintenance shown for 14 days.
  - in the API: banners read without the host filter, or with withdrawn ones; publishing without the rules or without `If-Match`; dismissing without the visibility check; drafting with only read; IT Admins by any permission.
  - in the worker: emailing everyone; emailing twice after a crash; a suspended outbox sending everything; failed emails counted as sent. That last one survived at first: the test had one email of each, so I made the counts lopsided.

**Decisions made while building, approved by the owner on 2026-11-14:**

| # | Decision | Why |
| --- | --- | --- |
| Q-C1 | **One PR, two commits** (notices, banners and rings; then the emails and the delivery log), not two PRs. | The emails need the deliveries; one review sees the whole of Q9 to Q12. |
| Q-C2 | **The audience is fixed when a notice is published:** a delivery row per institution. A ring changed later doesn't move a published notice. "Every institution" and a ring reach those onboarding, live or suspended; not one being provisioned, offboarding, archived or purged. | What an institution was told is what the record says (Q9). Offboarding arrives with S7, and its warning emails are its own. |
| Q-C3 | **IT Admins are whoever holds `settings.product.manage`** (switching the institution's products on), decided by the policy for banners and by the role's permissions for the emails. Today only the system role INSTITUTION_ADMIN holds it. | A permission, not a role's name: it follows the institution's own roles, and only the policy reads grants (spec 0018 PS7). |
| Q-C4 | **Markup isn't refused; it's shown as text.** Control characters and bidirectional overrides are refused, and a title is one line. | T34's test finds `<script>` as text. A title becomes an email subject, where a line break could add a header. |
| Q-C5 | **Drafts are edited under `If-Match`; publishing takes `If-Match` too.** Edits to a draft aren't audited; drafting, publishing, withdrawing and discarding are. The text stays on the notice's row, out of the audit chain. | What's published is what was read. The text never changes once published, so the row is the record. |
| Q-C6 | **A maintenance window is at most a week,** and its banner shows from publishing until the window ends. | Longer is an incident (PR D). Showing it before it starts is the point. |
| Q-C7 | **A notice withdrawn before its emails went out emails nobody** (recorded as 0). Emails are counted for two weeks; "failed" means the mail server refused it after the outbox's retries. | Nobody is emailed about a notice that's gone. Bounces need a real mail provider (out of scope). |
| Q-C8 | **Dismissing is per person, recorded at the institution;** only a banner shown to that person can be dismissed (404 otherwise). | ADR-035: the platform counts dismissals, never who. |
| Q-C9 | **The email** is plain text: "UniVarse: {title}" as its subject, then what it is, the window in Nigerian time, the message as written, and why they got it. It's sent from the platform's usual sender. | Plain words, one next step; no markup in any channel. |
| Q-C10 | **The tests address no notice to every institution:** the database is shared with development. "Every institution" is proved in `packages/domain`. | A test must not put a banner on the owner's real institutions. |

## PR D: what was built

**Built:**
- **The rules** (`packages/domain/src/platform/incidents.ts`): what an opening and an update must hold (a one-line title; public text of 3 to 1,000 characters; an optional note up to 2,000; no control characters or bidirectional overrides; markup kept as text; aware no earlier than started, neither in the future); resolved is final; an incident shows at its institutions while open and for a day after resolving; the 72-hour deadline from awareness when personal data may be involved (yes, or not yet known). The new permission `platform.incident.manage` (OWNER, SUPER_ADMIN, SUPPORT), with step-up.
- **The tables** (migration `20261117120000_incidents`):
  - `platform_incident`: the current state.
  - `platform_incident_update`: the timeline, append-only for every role (a trigger).
  - `platform_incident_tenant`: the affected institutions, decided at opening. Its capture trigger fires on arrival and on each update's touch, so the banner changes at once; the capture gate now has 15 triggers.
  - The opening never changes, and a resolved incident stays resolved (a trigger).
  - The tenant API's role reads only the title, status, times and the updates' public text: never an internal note, the follow-up, the personal-data flag or who did anything.
- **The platform API:** `GET/POST /incidents`, `GET /incidents/:id`, `POST /incidents/:id/updates` (with `If-Match`), `PUT /incidents/:id/followup` (with `If-Match`, after resolving).
- **The tenant API:** `GET /api/v1/tenant/incidents` (public), kept per institution for the tenant cache's bound.
- **The inbox:** open incidents (most severe first, with the clock) for those who run incidents; maintenance starting within 24 hours for those who publish notices.
- **The web app:** the service-status banner above any notice, on the sign-in pages and in the workspace, as text only.
- **The console:**
  - An Incidents tab, with open incidents first.
  - Opening an incident.
  - Its page: the chips, the 72-hour clock, the affected institutions, posting an update, the timeline with staff-only notes set apart, and the follow-up.
  - The inbox's two new items.

**Evidence:**
- **Domain:** 126 tests (6 new): the opening and update rules (markup kept as text), resolved is final, how long an incident shows, the 72-hour deadline for "yes" and "not yet known", and the permission's holders.
- **Integration**, against the real databases:
  - `incidents.int.spec.ts` (7):
    - who may open and update (404 otherwise; a step-up asked for);
    - an incomplete opening and one reaching no institution with people refused;
    - the latest public text, markup included, at the affected institution only;
    - never the internal note or the follow-up, and each update reaching the institution's cache;
    - `If-Match` on updates;
    - resolving final, still shown for the day, the follow-up only after, and the audit chain holding no text;
    - the clock for "not yet known" and gone for "no";
    - the timeline and opening refused changes for every role, and the tenant API's role unable to read a note, the follow-up or the flag;
    - the inbox's two items to the right roles, an incident leaving it once resolved.
  - The grants pin, the identity pin (SUPPORT's new permission), the route sweep (the new public route) and the database package (55, the isolation sweep included) pass.
- **E2E**, desktop and phone, axe on every screen:
  - console `incidents.e2e.ts` (4): SUPPORT opens one, sees the clock and the note apart, finds it in the inbox, updates, resolves and writes the follow-up; READ_ONLY reads and changes nothing.
  - web `incidents.e2e.ts` (4): the incident on the sign-in page as plain text, never its note; in the workspace; nowhere at another institution.
  - The whole console suite passes (50); the web suites except documents (which need ClamAV) pass (64).
- **Mutations: 14 tried, 14 caught:**
  - in the domain: resolved shown forever; no clock for "not yet known"; updates after resolving; aware before start.
  - in the API: banners without the host filter; updates without `If-Match` or the resolved check; the follow-up before resolving; opening without the rules, reaching archived institutions, or with only read; updates not telling the institutions.
  - in the inbox: incidents for everyone; resolved incidents listed.

**Decisions made while building, for approval:**

| # | Decision | Why |
| --- | --- | --- |
| Q-D1 | **Each update carries the incident's status, severity and personal-data flag at that moment;** the incident's row holds the current ones. Severity and the flag can change with any update until it's resolved. | Incidents escalate and de-escalate; the timeline shows when. |
| Q-D2 | **Resolved is final.** A recurrence is a new incident. Only the follow-up is written after. | The timeline stays a true record; a reopened incident would blur when it was over. |
| Q-D3 | **The 72-hour clock runs when personal data is "yes" or "not yet known"**, from when we became aware, and stops showing once it's resolved. The system sends nothing (Q14). | "May be involved" includes not knowing yet: the clock is already running then. |
| Q-D4 | **An incident's banner isn't dismissible,** and shows to everyone at the affected institutions, on the sign-in page too. | It's the service's state, not a message; it leaves a day after resolving. |
| Q-D5 | **"Every institution" means every one with people** (onboarding, live, suspended), as notices; the affected ones are fixed at opening. | Same rule as Q-C2: the record says whom it affected. |
| Q-D6 | **An update and the follow-up take `If-Match`;** opening doesn't (it's new). | Two people running one incident shouldn't post past each other. |
| Q-D7 | **The audit chain holds the choices (severity, status, flag, how many institutions), never the text;** the text is on the timeline, which never changes. | As Q-A7 and Q-C5. |
| Q-D8 | **Maintenance soon goes to those who publish notices;** open incidents to those who run them. | Each item to whoever can act on it (Q15). |
| Q-D9 | **The test clean-up removes a test's own incidents** (disabling the append-only trigger for that delete only, as the migrator). | The timeline is append-only for every other purpose; members are never deleted for real, only the tests' are. |
| Q-D10 | **No test opens an incident affecting every institution:** it would show on the shared database's own institutions for a day. | As Q-C10. |
