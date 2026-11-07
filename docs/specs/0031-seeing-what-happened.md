# Spec 0031: Phase 1's S3, seeing what happened

**Status:** **Approved by the owner on 2026-11-07, all as written:** Q1 to Q17, and Q-A1 to Q-A4 (with #156). PR A merged; PR B built; the release next.
**Phase:** 1, slice **S3** of [spec 0025](0025-phase-1-control-plane.md) (E1, E2, E3).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): E1 (the audit viewer and chain verification; viewing is audited), E2 (security events), E3 (the monthly access review), and A5 (a slice adds its own `platform.*` permissions);
- [spec 0028](0028-console-identity.md): the console's sign-in, roles, step-up and audit (Q15), and its closing notes;
- [spec 0006](0006-envelope-encryption.md) E12: the platform audit chain; [spec 0012](0012-observability-logs-and-traces.md) OB7: the security stream;
- [08 §12](../08-security.md) (security events), [14](../14-observability-and-operations.md) §2, §5 and §9 (the stream's 12 months, a chain failure as a Sev-1 candidate, the monthly access review), [16 §5](../16-compliance-ndpa.md) (retention), [11 §9](../11-frontend-guidelines.md) (the console's UI rules), and [spec 0026](0026-phase-1-start-threat-model-and-storybook.md) T26 (a platform insider).

## Why

The platform now records everything staff do, on a hash chain, but nobody can read it without database access: the chain exists, and **nothing reads it**. Security events go to a log stream that, on the stack, nobody watches. And the monthly access review docs/14 asks for has nowhere to happen. Before S4 gives staff real power over institutions, the console has to show what happened.

## What exists today, and what the code showed

- **The chain is sound.** `verifyPlatformAuditChain` passed on the development database on 2026-11-07: 3,297 rows, in 1.4 s, including everything S2 wrote.
- **But the verifier reads the whole table into memory at once.** That's harmless in a CLI, and not in a process with a 384 MiB limit (Q5).
- **A chain alone can't see its newest rows being deleted:** what remains is still a valid chain (Q7).
- **`SECURITY_EVENTS` has 17 events, in logs only.** Nothing stores them where the console can read them, and the console can't read the logs (Q8).
- **docs/14 alerts on RLS violations, and no code emits that event** (Q11).
- **S2's relay crash** (spec 0028's closing notes) is the lesson for this slice's own background work (Q10).

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **New permissions, in `packages/domain` as A5 says:**<br>• `platform.audit.read`: OWNER, SUPER_ADMIN, READ_ONLY;<br>• `platform.audit.verify`: OWNER, SUPER_ADMIN;<br>• `platform.security.read`: OWNER, SUPER_ADMIN, READ_ONLY;<br>• `platform.access_review.read`: OWNER, SUPER_ADMIN, READ_ONLY;<br>• `platform.access_review.attest`: OWNER only, with step-up.<br>SUPPORT and FINANCE get none of them for now. | The audit log holds staff addresses and what each member did, so it follows the staff list, not "everyone". READ_ONLY exists to see what others do. Alternative: SUPPORT reads security events, to help institutions. Left for S9, when support exists. |
| Q2 | **The audit viewer:** `GET /api/platform/v1/audit`, newest first, 50 a page (at most 200), an opaque cursor over `seq` (docs/06). Filters: an action or action group, the actor, the institution, and a date range. No free-text search over metadata. | `seq` is unique and ordered, so paging is stable while rows are being added. Free text would need a scan of a table that only grows. |
| Q3 | **Viewing is audited, once per query, not per page:** the first page of a query writes `platform.audit.viewed` with its filters (ids and dates) in the same transaction as the read; following a cursor doesn't. | E1 requires it, and a row per page would fill the chain with noise and take the chain's lock on every scroll. This is a `GET` that writes, deliberately and only here. |
| Q4 | **What a row shows:** a plain-language label for the action (a catalogue in `packages/contracts`; an unknown action shows as its raw name, never hidden), the actor's current name, or "the system", or "a former member" with the id, the institution, the time in WAT, and the address. The detail view shows the metadata as data. Names come from a join at read time, because metadata holds ids only (spec 0028 Q15). | People read names, and the chain must keep holding none. |
| Q5 | **Verification reads in pages of 1,000, by `seq`,** holding one page and the running hash. `verifyPlatformAuditChain` becomes a pure walk over a page source, so the CLI, the console and the tests share it. | Memory stays flat however long the chain grows. A pure walk is also what lets tests tamper with rows safely (Q16). |
| Q6 | **Verification runs in the background, one at a time:** a member with `platform.audit.verify` starts it, the page shows progress, and it also runs by itself every 24 hours. Each run is a row in `platform_audit_verification` (started, finished, by whom or the schedule, rows checked, the result, the head's `seq` and hash) and an audit event. A broken chain logs `platform.audit.chain_broken` at error and shows a banner to everyone with `platform.audit.read`, until a later run passes. **It changes nothing and blocks nothing:** a human decides (CIA, invariant 12). | The request can't wait for a long walk. docs/14 makes this a Sev-1 candidate, so it must be seen without anyone asking. |
| Q7 | **Each run also checks that the last recorded head still exists, with the same hash.** That catches rows deleted from the end, which the chain alone can't. | It closes the truncation gap, within one limit: **someone who can rewrite the database can rewrite the chain and these records together**, because the hash is unkeyed and everything is in one database. An anchor outside the database is the real answer, and belongs with hosting (Out of scope). The roles' grants (no `UPDATE` or `DELETE`) are what stop this today. |
| Q8 | **Security events are stored as per-minute counts, never as individual rows:** `platform_security_event_rollup` (minute, event, source, institution or none, count, last seen). No user id, no address, no detail. The logs stay the complete record. | These events are what an attacker triggers: one row each would let a flood write to the platform database. Counts are bounded and hold nothing personal, and they answer what the page asks: what's happening, where, how much. Alternative: read the logs. Rejected: the console has no access, and shouldn't have. |
| Q9 | **One tap, no call-site changes:** a hook on the logger catches every line with `stream: "security"`, in the API, the worker and the platform API. It reads only `event` and `tenantId`, adds to an in-memory count, and writes every 30 seconds in one statement. The buffer is capped (10,000 keys); past the cap it drops and counts what it dropped, and logs that. **It never waits on the database inside a request.** | Every event now and later is captured by default. A slow or dead database can't slow a sign-in, and a crash loses at most 30 seconds of counts, which the logs still hold. |
| Q10 | **Every background pass goes through one small helper, which catches and logs:** the mail relay moves onto it, with the rollup writer and the daily verification. A failed pass ends there, and the next tick tries again. | The relay's crash was one missing `catch` on one timer. A shared helper makes the safe way the easy way; a unit test covers it. |
| Q11 | **Close the gaps between 08 §12 and the code:** a new `db.rls_violation` event, from the API's error handling on PostgreSQL's `42501` and row-level-security errors, at error, with its tenant and route, never the query. `platform.audit.chain_broken` (Q6) joins the list. Later events arrive with their slices: webhook signature failures (Phase 3), mass exports (S7), break-glass (S9). The spec records which are live. | docs/14 pages on a number no code produces, so a cross-tenant attempt that RLS stops today is invisible. This is the one change on the tenant side. |
| Q12 | **Three levels, in `packages/domain`:** **act** (`files.scan.malware_detected`, `db.rls_violation`, `platform.audit.chain_broken`, the undeclared-route events), **watch** (lockouts, invalid tokens, CSRF rejections, failed step-ups, allowlist refusals), **note** (rate limits, staff changes). An unknown event shows as **watch**. | A pure table is simple to test, and it lets the page lead with what matters. Alternative: thresholds that page someone. Left for E25, the inbox in S6: S3 shows; S6 tells. |
| Q13 | **The security page:** totals by level and event over the last 24 hours, 7 days or 30 days, per institution or for the platform; a chart of counts over time; each event in plain language, with what to do about it. Institutions show by slug, so the console role gets `SELECT` on `tenant` (id, slug, name) only. | A staff member should be able to tell in ten seconds whether anything needs them. |
| Q14 | **Retention:** rollups for 12 months (docs/14 §2), pruned by S5's maintenance queue, the first scheduled job; until then the table grows only when events happen. Audit rows and verification records are kept (16 §5), never pruned. | The queue arrives in S5, and a separate timer for this isn't worth it: a year of rollups is small. |
| Q15 | **The monthly access review:** one per calendar month in WAT. The page lists every member with role, status, authenticator state, last sign-in and sessions; the reviewer marks each **keep** or **needs a change**, with an optional note, and attests with step-up. The row (`platform_access_review`) holds a snapshot of what was attested, by ids, and a hash of it; the server rebuilds the snapshot at attest and refuses (409) if anything changed since the page loaded. A review can't be edited, and "needs a change" opens the Staff page: the review changes nothing itself. Overview shows **due** or **overdue** to OWNERs. | The evidence is "this is what I saw and approved", so it has to be fixed and exact. **A solo owner reviews their own access**: it's recorded honestly, not presented as independent, and A7 doesn't apply, as nothing is destroyed. Reviewing tenant admins (also in docs/14 §9) needs tenant data, so it's a tenant-side feature, in Phase 2. |
| Q16 | **Tests never tamper with the real chain.** The chain is append-only and shared with development, so a test that edits a row would break it for good. Tampering is proved on the pure walk (Q5) with rows in memory: a changed row, a deleted row, a reordered row, a truncated tail. Integration tests use the real table for reading, paging, viewing and running only. | The acceptance "a tampered row is detected" needs no real tampering. PR A's lesson about tests polluting development applies here more than anywhere. |
| Q17 | **Two PRs, one release.** **A:** the migration and grants, domain, the walk, verification, the rollups and their tap, `db.rls_violation`, the access review, the routes, and integration tests. **B:** the three screens, Overview's status, and the E2E. Then the release and the deploy, because the API image changes. No new secrets and no stack changes. | Each reviewable alone, as S2 was. |

## Acceptance criteria

1. **Audit viewer:** every platform route's permission is swept (404 without it); filters and paging return the right rows with no gaps or repeats while rows are added; no email or name in any metadata (a test).
2. **Viewing is audited,** once per query (a test), in the same transaction as the read.
3. **Verification:** the pure walk catches a changed, deleted, reordered or truncated row (Q16); memory stays flat over a long chain (a test on the page size); a broken chain shows a banner and logs the event; a passing run clears it.
4. **The first run on the stack passes** on the real chain.
5. **Rollups:** a burst of events writes bounded rows; a dead database never slows or fails a request (a test); the buffer's cap holds; no user id, address or detail is stored (a test on the table's columns and the writer).
6. **A role-level check:** an RLS violation in a test produces `db.rls_violation`, in the log and in the rollup.
7. **Access review:** one per month; attest needs step-up and OWNER; a change between loading and attesting is refused; a stored review can't be changed by the console role (its grants, tested).
8. **Background work:** a failing pass of the relay, the rollup writer or the daily verification ends in a log line, never an unhandled rejection (a test each).
9. **Isolation:** the console role still has no grant on any tenant database, and gains only what this spec names (the exact-grants test).
10. **Screens:** axe (WCAG 2.2 AA), phone and desktop, no sideways scroll; E2E for a member with each role.
11. **Mutation checks** on each control above: each one removed fails a test.
12. **Released and deployed;** the owner completes the first access review on the stack.

## The owner's steps

- ~~Approve or change Q1 to Q17.~~ Done on 2026-11-07.
- After the PRs: the release and the deploy.
- On the stack: run the first chain verification and the first access review.

## Affected docs (in the implementation PRs)

- [03 §1](../03-domain-model.md): the new platform entities;
- [06](../06-api-guidelines.md): the routes, and `GET` writing an audit row (Q3);
- [07](../07-data-and-database.md): the tables and grants;
- [08 §12](../08-security.md): which events are live; [14](../14-observability-and-operations.md): what the console shows, and the rollups;
- [12](../12-testing-strategy.md): the new sweeps; [17](../17-coding-standards.md): background passes go through the helper (Q10);
- [18](../18-roadmap.md): S3's status.

## Out of scope

- **An anchor for the chain outside the database** (Q7): with hosting, in Phase 8.
- **Exporting the audit log:** with S11's evidence pack, where it has a purpose; 05 §17's export is the tenant's.
- **Alerts and the inbox** (E25): S6. **Tenant-side audit viewing:** the tenant's own product, Phase 2 onwards.
- **Tenant data of any kind:** the console sees counts and ids, as always.

## Implementation notes (PR A, 2026-11-07)

**Built:**
- **The migration** (`20261107120000_seeing_what_happened`): the three tables, the viewer's two indexes on the chain, and the grants. It revokes what the migrator's default privileges would have given the tenant API's role.
- **`packages/domain`:** the five permissions, the security levels (Q12), and the review's rules (the month in WAT, its status, the snapshot's identity).
- **`packages/crypto`:** `walkPlatformAuditChain`, a pure, paged walk that also checks a recorded head. `verifyPlatformAuditChain` now runs on it.
- **`apps/api/src/platform/observe/`:** the audit log, chain verification, the security view, the access review, and their routes.
- **`shared/observability`:** `backgroundPass` (Q10), and the rollups with their tap on the logger (Q9). The mail relay moved onto `backgroundPass`.
- **`db.rls_violation`** in `ProblemFilter`, through `isPermissionRefused` in `packages/db`.

**Evidence:**
- **Unit:** 442 API tests pass, with the pure walk's 15 and the domain's 63.
- **Integration:** `observe.int.spec.ts` (22) as the console role through the platform API's HTTP stack; `rls-event.int.spec.ts` (4) with a real cross-tenant insert; the exact-grants test extended, including the three `tenant` columns.
- **`pnpm rls:check`** passes, as does the session-SQL scan.
- **Mutations: 16 tried, 16 caught:**
  - the tap, the buffer's cap, undeclared events, and a failed write losing its rows;
  - a background pass rethrowing;
  - no tail check, and no head hash check;
  - a broken chain logging nothing, and two runs at once;
  - every page audited, and viewing not audited;
  - no snapshot check, decisions not required, and notes in the chain;
  - attesting without a step-up, and the security page open to everyone.

**Corrections to the draft, found while building:**
- **The snapshot's hash covers access only** (id, role, active, authenticator). Q15 said the server refuses if "anything changed", but a last sign-in changes whenever anyone signs in, the reviewer included, so a hash over it could never match. Last sign-ins are stored in the snapshot, not hashed.
- **The rollups use an all-zero id for "no institution",** because PostgreSQL treats NULLs in a key as distinct, and two such rows wouldn't add up.
- **`db.rls_violation` covers refused statements on the HTTP path.** A refusal in a background job shows in that job's own failure log. It also fires on a missing grant, not only RLS: PostgreSQL reports both as `42501`, and either means something tried what it mustn't.

**Decisions made while building PR A, approved by the owner on 2026-11-07:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **A review's "overdue" starts only after a first review:** a platform that has never reviewed is `due`. | Otherwise the first month after S3 ships would open as overdue, which is noise and teaches people to ignore it. |
| Q-A2 | **`platform.mail.failed` is level `act`.** | Q12's table didn't list it. A staff member's activation or security mail that can't be delivered needs a person. |
| Q-A3 | **Starting a verification is limited to 6 a minute per address.** | It reads the whole chain. One run at a time already bounds the work; the limit stops a stuck script filling the run table. |
| Q-A4 | **Verification runs and the access review's history are read at most 10 and 24 rows back.** | The page shows recent ones; older runs stay in the table. |

## PR B: what was built

The three screens, Overview's status and the shell's banner, in `apps/console`. **Labels live in `packages/contracts/src/platform-labels.ts`,** and a test (`apps/api/src/platform/observe/labels.spec.ts`) fails on an audit action or security event with no words, and on words for an action nothing writes. An unknown name shows raw: the log never hides a row.

**Corrections found while building:**
- **The chart holds one more bucket than the window has hours or days** (25, 8, 31): the window starts part way through its oldest bucket, and without it, events counted in the totals fell off the left edge.
- **`crypto.ledger.<action>` names come from the stack's ledger job at run time,** so the label test can't list them. `crypto.ledger.waived` is labelled; any other shows as its raw name.
- **The E2E's test reviews now go when their reviewer does:** `pruneRetiredTestStaff` removes reviews whose reviewer no longer exists. A test's attested month was blocking the month on the shared development database.

**Decisions made while building, for approval:**

| # | Decision | Why |
| --- | --- | --- |
| Q-B1 | **Filters apply on a Show button, not on each change.** | Every new query writes `platform.audit.viewed` (Q5), so filtering as you pick would fill the log with its own reads. |
| Q-B2 | **A picked date means that whole day in WAT,** whatever the browser's zone. Times shown stay in the reader's own zone, as everywhere else in the console. | The platform's calendar is WAT, as the review's month is (Q15). |
| Q-B3 | **The "Who" filter lists staff only for those who can read the staff list.** All three roles with the log can, today. | It reuses `GET /staff`, with no new route. If the read fails, the filter lists only "Anyone" and the log still works. |
| Q-B4 | **The chart is HTML bars, with no chart library, and its table sits one tap away.** Its amber passes the colour-blind checks but is weak on contrast, so every chart shows a legend, each event names its level in words, and the table holds every value. | Low-end Android on slow networks. |
| Q-B5 | **A review's decisions all start unset:** Attest stays disabled until each member is marked, with no "keep all". | The attestation says a person looked at each one. |
| Q-B6 | **The note about reviewing your own access shows only when you're the sole member.** | Q15 says a solo owner's review is recorded honestly. With two or more members, the reviewer's own row is marked "(you)". |
| Q-B7 | **Overview's due or overdue chip shows to whoever can attest, which is OWNERs,** and nothing shows when the month is done. | Q15. |
| Q-B8 | **On a phone, the current tab scrolls into view.** With six tabs, the one you're on was off-screen. | Found on the phone screenshot. |
