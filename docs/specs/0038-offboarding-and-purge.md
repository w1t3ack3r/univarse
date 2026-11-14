# Spec 0038: Phase 1's S7, offboarding, the export and purge

**Status:** **Approved by the owner on 2026-11-14, all as written:** Q1 to Q15. ADR-037 (the AES ZIP's dependency) is written with PR B.
**Phase:** 1, slice **S7** of [spec 0025](0025-phase-1-control-plane.md) (A7, A12, E10).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A2 (the console holds no tenant credential), A7 (two people for destructive actions, no solo bypass), A12 (a purge is a crypto-shred, then row deletion);
- [spec 0020](0020-local-backups-and-shred-ledger.md): the shred ledger, `pnpm stack:keys destroy`, recovery's re-apply after any restore, and the drill's `key_destroyed` check;
- [spec 0037](0037-approvals-suspension-notices.md): the approval engine (a new kind), suspension, the inbox, and IT Admins as holders of `settings.product.manage`;
- [spec 0034](0034-provisioning.md): the worker's queues and the tenant outbox for an IT Admin's email;
- [spec 0010](0010-file-uploads.md): files in storage under `tenants/{tenantId}/`;
- [05 §1](../05-modules-and-features.md) (offboarding, the export), [07 §8–10](../07-data-and-database.md) and [16 §5](../16-compliance-ndpa.md) (crypto-shredding, retention, backups), [08](../08-security.md) T26, T29.

## Why

An institution leaves: its contract ends, or it asks to go. The platform must then do three things, in order. It gives the institution its data and time to take it (60 days, warned at 45, 30, 14, 7 and 1). It closes the institution's address. Then it destroys the data, so that no backup can bring it back into use, and says so in writing (16 §5: "purge + certificate of deletion"). Destroying is the one action in Phase 1 that can't be undone, so it takes two people (A7).

## What exists today, and what the code showed

- **The statuses exist; nothing sets them.** `TenantStatus` has `OFFBOARDING`, `ARCHIVED` and `PURGED`, and `tenant` has `offboarding_started_at` and `purge_after`. The registry refuses edits to archived and purged institutions. The tenant guard answers 404 for both.
- **Key destruction runs only on the host.** `pnpm stack:keys destroy <tenant>` writes the shred ledger outside the stack before it reports a destruction done. Every deploy and restore re-applies it. In production the API refuses to destroy keys except as that protocol's one-shot job (spec 0020 D14). So the console can't purge by itself, and a worker can't either.
- **Files aren't encrypted under the institution's keys.** Uploads live in storage as `tenants/{tenantId}/q/…` and `tenants/{tenantId}/c/…`, so destroying the keys leaves them readable. A purge must delete them.
- **The tenant audit chain is append-only** (invariant 5): the app role can't delete it.
- **Backups hold everything until they expire** (spec 0020 D6, about 35 days). Keys stay destroyed after a restore, through the ledger; files and rows in an older set don't, until the set is pruned.
- **The approval engine takes new kinds** (spec 0037 Q2): a purge is one.

## Decisions (approved 2026-11-14)

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **Permissions.**<br>• `platform.tenant.offboard`: start, cancel and extend offboarding, and ask for a purge. OWNER, SUPER_ADMIN, with step-up.<br>• Deciding a purge is `platform.approval.decide` (OWNER, SUPER_ADMIN), as every approval.<br>• On the institution's side, `data.export.request`: request and download the full export. Privileged, with step-up; granted to `INSTITUTION_ADMIN` by default. | Offboarding starts a clock that ends in destruction, but it can be cancelled until then: one person, as suspension. The destruction is the two-person step. |
| Q2 | **Starting offboarding:** one person, step-up, a reason from a fixed list (the contract ended, the institution asked, a regulator's order, other, with a staff-only note). From `ACTIVE` or `ONBOARDING`. It sets `offboarding_started_at` and `purge_after` (60 days later, at the end of that day in Nigerian time), is audited, and the IT Admins are emailed at once. **Cancelling** before the 60 days are up returns the institution to the status it had; nothing has been lost yet. | The window is the institution's: it starts when we tell them, and a mistake costs nothing until it ends. |
| Q3 | **During the window the institution works as before**, with a banner to everyone: "UniVarse closes for {institution} on {date}." IT Admins also see how to download the export. It can still be suspended; a resume returns it to `OFFBOARDING`, and the clock doesn't stop. | People finish the session and move their records out; nothing breaks mid-term because a contract ended. |
| Q4 | **Warnings at 45, 30, 14, 7 and 1 days**, by email to the IT Admins through the institution's outbox (as notices are), each sent once and recorded on the platform (counts only, ADR-035). Missed days (the worker was down) send the most recent one due, never a backlog. | 05 §1. A backlog of five emails on one morning helps nobody. |
| Q5 | **On day 60 the worker archives the institution:** `OFFBOARDING` → `ARCHIVED`, audited with a system actor; every session ends (spec 0037 Q7's job). Its addresses then answer **410 `tenant.closed`**, and the web app shows "{institution}'s UniVarse account has closed", in its name and colours. The data is still there, unreadable to anyone. | A closed account says so, plainly (as Q8 of spec 0037 did for suspension), and the export can't be taken after the window it was offered in. |
| Q6 | **An archived institution can be given 14 more days, once:** one person, step-up, a reason. It goes back to `OFFBOARDING` with a new end date and a warning at 7 and 1 days. | An institution that missed its export shouldn't lose its data to a calendar. Once, so the window can't run forever. |
| Q7 | **The export (05 §1, "full, for portability"):** an IT Admin requests it in the workspace whenever the institution is active, onboarding or offboarding; one at a time, at most one a day. The worker builds it in a queue of its own:<br>• one JSON Lines file per table, every row of the institution, encrypted fields decrypted;<br>• never a secret: no password, token, code or recovery hash, authenticator secret, session, challenge or outbox payload;<br>• every clean file, as uploaded;<br>• a `manifest.json` with each table's row count and each file's SHA-256, and a `README.txt` saying what each file holds. | The institution is the controller (16): the export is its records, readable without UniVarse, and nothing in it lets anyone sign in. |
| Q8 | **The export is encrypted, and only the institution can open it.**<br>• **Format:** an AES-256 ZIP (WinZip AE-2), which 7-Zip and most archive tools open. A new dependency, with an ADR (ADR-037).<br>• **The passphrase:** made by the API when it's requested, shown once to the IT Admin who asked, and never stored in the clear. The worker gets it encrypted under the institution's key and wipes it once the archive is sealed.<br>• **Where it's kept:** in a private exports bucket, for 7 days.<br>• **Downloading:** only in the institution's workspace, by an IT Admin, with step-up, streamed and audited. There's no link that works anywhere else, and the download is deleted after the 7 days or at the purge.<br>• **What the platform sees:** the export's state, its size and its counts, never its content. | T29: "exports encrypted, with a short-lived, single-tenant link, audited". A link that works without signing in can be forwarded; a passphrase stored next to the archive protects nothing. |
| Q9 | **A purge is a new approval kind, `tenant.purge`,** for an `ARCHIVED` institution only. One member asks (`platform.tenant.offboard`), another approves (spec 0037's rules: not the requester, the shown hash, single use, an expiry). The approval's executor doesn't destroy anything: it records a **purge authorisation**, valid for 7 days. | The approval engine is the two-person record; the destruction itself can only run on the host (spec 0020 D14). |
| Q10 | **The purge runs on the host: `pnpm stack:purge <slug>`,** by the owner, with an authorisation in force. Each step is idempotent, and a stopped purge resumes from the step it stopped at:<br>1. **Destroy the keys** through `stack:keys destroy`'s own protocol, so the ledger holds the destruction and every later restore re-applies it.<br>2. **Delete the institution's rows** in a one-shot job as the migrator: every tenant table, its audit chain included, under its own RLS context.<br>3. **Delete its files and exports** in storage (`tenants/{tenantId}/` in every bucket).<br>4. **Delete its platform rows** (domains, products, branding, regulatory details, deliveries, incident links, suspensions), and set the tenant `PURGED`.<br>5. **Write the certificate of deletion** (Q12).<br>It refuses the drill tenants (`shred-drill-*`), which are evidence. | A12 in order: keys first, so nothing deleted later can be read from a backup, then the rows. |
| Q11 | **No solo bypass, as A7 says.** When nobody but the owner can approve, the console offers no purge request (spec 0037 Q5). `pnpm stack:purge <slug> --solo --reason "…"` then runs without an authorisation, but only after checking live that no second possible approver exists. It's recorded as solo in the ledger, the audit chain and the certificate. | A7: until there's a second person, a destructive action stays the owner's CLI protocol, and it says it was one person. |
| Q12 | **The certificate of deletion:**<br>• **Content:** the institution (id, slug, legal name), who asked and who approved (or "solo"), when the keys were destroyed (the ledger's op), the rows deleted per table, the objects deleted, and the date by which the last backup holding any of it expires (from `pnpm stack:backup status`'s boundary).<br>• **Form:** JSON plus a plain-text rendering, saved in `~/.univarse/purges/`, its SHA-256 recorded on the tenant's tombstone. The console shows it, and staff can download it to send to the institution. | 16 §5. It says what was destroyed, when, and when the last copy goes, without overstating it. |
| Q13 | **What stays after a purge:**<br>• **The tenant row**, as a tombstone: id, slug, type, `PURGED`, its dates and the certificate's hash. The slug stays reserved for good, so an old address can't point at a new institution.<br>• **The platform audit events** (ids only) and the shred ledger.<br>• **Older backup sets,** until they expire (about 35 days). Keys stay destroyed after any restore (the ledger), but rows and files in an older set don't, until it's pruned. The certificate says so. | Deletion that can be proved, without pretending backups vanish. |
| Q14 | **The tenant audit chain is deleted with the institution's data.** Invariant 5 (append-only) holds for every other purpose; the purge is its one exception, and the institution received the chain in its export. The platform's own audit events of the purge remain. | The 10-year audit retention (16 §5) is the controller's; we hand it over rather than keep a copy of a departed institution's records. |
| Q15 | **The console:**<br>• the institution's page gains an Offboarding section: start, the countdown, the warnings sent, the export's state (counts only), cancel, extend, ask for a purge, and the purge's state and certificate;<br>• the inbox lists institutions whose window ends within 7 days, and purges authorised but not yet run.<br>**The web app:** the closing banner, the export page for IT Admins, and the closed page. | One place to see where a departure stands. |

## New threats

| # | Threat | Vector | Controls |
| --- | --- | --- | --- |
| T35 | **An export leaks** | A forwarded link, a passphrase stored beside the archive, an export of the wrong institution, a platform member taking one | No link outside the institution's own workspace; the passphrase is shown once and never stored in the clear; IT Admins only, with step-up, audited; the job reads only its own institution (from the registry, never the payload); the platform sees state and counts, never content; deleted after 7 days |
| T36 | **The wrong institution is purged, or too soon** | A slip of the slug, a purge of a live institution, one person alone, a forged authorisation | `ARCHIVED` only; two people through the approval engine (the shown hash names the institution); the host command checks the authorisation against the slug and its expiry; solo only when no second person exists, and recorded as such; drill tenants refused |

## Acceptance criteria

1. Every new route declares its permission, the route sweeps cover them, and out of scope is 404.
2. Offboarding starts from active or onboarding only, can be cancelled before day 60, and archives on day 60. The warnings go out at 45, 30, 14, 7 and 1 days, once each, to IT Admins only.
3. An archived institution's addresses answer 410 with the closed page, and its sessions end. One 14-day extension works; a second is refused.
4. **The export opens with its passphrase and matches the institution's row counts** (spec 0025). It holds no secret (a test reads every file for the columns Q7 excludes). It downloads only for an IT Admin with step-up, and the platform can't read it.
5. **A purge without two approvals is refused** (spec 0025), unless no second person exists and it runs solo, recorded as such. The requester and the approver can't be the same member.
6. **After a purge, a restore of a set taken before it leaves the institution `key_destroyed`** (spec 0025, the drill's check, reused). Its rows and files are gone from the live stack, its slug can't be reused, and the certificate states what was deleted and when the last backup expires.
7. A purge stopped at any step resumes from that step.
8. The new console screens, the export page, the banner and the closed page pass axe at WCAG 2.2 AA on desktop and phone.
9. Released and deployed; **on the stack, the owner offboards a test institution, downloads and opens its export, takes it through archive (the day moved by a test clock), and purges it with a second person, then checks the certificate and a restore's `key_destroyed`.**
10. Mutation checks on the guards: the statuses each step allows, the warning days, the export's exclusions and its owner check, the two-person check and the solo check, the purge's step order, and the drill refusal.

## The PRs

| PR | What | Size |
| --- | --- | --- |
| A | Offboarding: start, cancel, the warnings, the banner, archive on day 60, the closed page, the extension | M |
| B | The export: the request, the worker's archive, the encryption (ADR-037), the download | M–L |
| C | Purge: the approval kind, the authorisation, `pnpm stack:purge` and its steps, the certificate, the drill check reused | L |

About **two weeks** at S6's pace.

## The owner's steps

- Approve or change Q1 to Q15, and the new dependency for the AES ZIP (ADR-037, written with PR B).
- After the PRs: the release and the deploy, then criterion 9's check (a test institution, a second staff account for the approval, removed after).

## Affected docs

[02 §7](../02-architecture.md) (the lifecycle), [03](../03-domain-model.md) (the tenant's states, the export, the purge and its certificate), [05 §1](../05-modules-and-features.md), [07 §9](../07-data-and-database.md) and [16 §5](../16-compliance-ndpa.md) (the purge as built), [08](../08-security.md) (T35, T36, T26, T29), [12](../12-testing-strategy.md) (a journey for offboarding to purge), [19](../19-decision-log.md) (ADR-037), [18](../18-roadmap.md) (S7's row).

## Out of scope

- **Single-tenant restore** from per-tenant exports (07 §10's nightly logical exports): the export here is the institution's, on request.
- **Purging part of an institution** (a student's erasure request): Student Affairs and the DSAR flow (16).
- **A hosted status of a departure for the institution after the purge:** there's no one left to sign in.
- **Shortening backup retention for a purge:** sets expire on their schedule (spec 0020 D6); the certificate says when.

## PR A: what was built

**Built:**
- **The rules** (`packages/domain/src/platform/offboarding.ts`):
  - which statuses can start;
  - the window's end at the end of a day in Nigerian time;
  - days left counted as people count them (1 on the last day);
  - the warning due now, the most recent only, never a backlog;
  - when to archive, cancel and extend;
  - the note's rule.
  - A suspension can now start from `OFFBOARDING`, and its resume returns there (Q3).
  - The new permission `platform.tenant.offboard` (OWNER, SUPER_ADMIN, with step-up).
- **The tables** (migration `20261118120000_offboarding`):
  - `platform_tenant_offboarding`: one open per institution. A trigger keeps the record unchanged and writes a cancellation and an extension once each.
  - `platform_offboarding_warning`: once per round and day, with counts only.
  - The console role starts, cancels and extends. The worker's role archives, ends the sessions and writes the warnings. Neither can do the other's part.
- **The platform API:** `POST /tenants/:id/offboarding`, `/offboarding/cancel` and `/offboarding/extend`, all `platform.tenant.offboard`; the institution's detail carries its latest offboarding.
- **The worker** (`OffboardingPass`, every 5 minutes):
  - sends the warnings through the institution's outbox, where the outbox's `notice_id` names the warning, so a stopped pass is finished without emailing twice, and the emails go out even while the institution is suspended;
  - archives after the last day;
  - ends every session and pending challenge at an archived institution, audited on both sides.
- **The tenant API:**
  - `OFFBOARDING` is served as before; the public profile carries `closesAt`.
  - `ARCHIVED` answers **410 `tenant.archived`** with the institution's public name and colours, documented on every institution route.
- **The web app:** the closing banner on the sign-in pages and in the workspace, and the "This account has closed" page (the workspace sends its visitors there).
- **The console:** the Offboarding section on the institution's page (start; the leaving view with the days left, the warnings and Cancel; the closed view with the extension), and the inbox's "closes within a week" item.

**Evidence:**
- **Domain:** 135 tests (9 new): the statuses, the window's end in Nigerian time, days left, the warnings (once each, the latest after a gap, the extension's round), the archive, the cancel and the extension's once, the note, and the permission's holders.
- **Integration** (`offboarding.int.spec.ts`, 9):
  - who may start, from which statuses, and the note;
  - the institution still served during the window, with `closesAt`;
  - a cancel returning it as it was, and refused after the last day even before the archive;
  - the warnings once each and never a backlog, emailed to IT Admins only, then the archive with its 410 and every session ended, audited in order;
  - a stopped pass finished without emailing twice;
  - a suspension during the window returning to it;
  - the extension once, with its own warnings;
  - the database's trigger, one open window per institution, and the warnings the console role can't write;
  - the inbox's item to the right roles.
  - The grants pin, the public profile's `closesAt` and the suspension suite are updated.
- **E2E**, desktop and phone, axe on every screen:
  - console `offboarding.e2e.ts` (4): an OWNER starts, sees the leaving view and its first warning, and cancels; an archived institution shows as closed and takes its extension.
  - web `offboarding.e2e.ts` (4): the closing banner, and the closed page from the sign-in page and the workspace.
  - The whole console suite passes (52, one mobile flake that passed on its rerun); the web suites except documents pass (68).
- **Mutations: 15 tried, 15 caught:**
  - in the domain: starting from any status, a backlog, warnings resent, archiving a day early, extending twice;
  - in the API: the status check, the note rule, cancelling after the end, the extension's once, starting with only read, warnings to everyone, warnings emailed twice after a stop, the archive leaving the sessions, an archived institution still served, the inbox item to everyone.
  - One survived at first (cancelling after the end, before the archive): no test covered that gap; one does now.

**Decisions made while building, for approval:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **The first warning is the announcement, sent when it starts ("60 days"),** and the extension's first is its own announcement ("14 more days"). The rounds' warnings are 60/45/30/14/7/1 and 14/7/1. | Q2 says the IT Admins are emailed at once; the warnings and the announcement are one mechanism. |
| Q-A2 | **On its first day the window has 61 days left** (the rest of today, then 60 days); the announcement is due from the start. | The window ends at the end of a day, and "today" counts. |
| Q-A3 | **A warning's emails are named by the warning in the outbox's `notice_id`.** The column names a platform message: a notice, or now an offboarding warning. | One mechanism for "delivered even while suspended", and for not sending twice. |
| Q-A4 | **The worker's offboarding pass runs every 5 minutes.** | The warnings are by day and the archive by end of day; a minute's precision buys nothing. |
| Q-A5 | **The 410's code is `tenant.archived`.** `tenant.closed` already means "archived, so it can't be changed" in the console's registry. | One code, one meaning. |
| Q-A6 | **An offboarding can't be cancelled while the institution is suspended:** resume it first. | Cancelling returns the status it had before offboarding, which would quietly end the suspension. |
| Q-A7 | **The database checks only that a window ends after it started.** An extension's end is normally later than the first end, but the database doesn't require it. | The extension is 14 days from the day it's given; the rule that matters (once) is the trigger's. |
| Q-A8 | **The closing banner names the institution's ICT unit as who can take a copy;** PR B adds the export they take it with. | The banner shows to everyone; the export is for IT Admins. |
