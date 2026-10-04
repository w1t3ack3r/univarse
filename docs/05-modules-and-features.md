# 05 — Modules & Features

The functional spec, per module. Each feature has a **phase** ([18-roadmap.md](18-roadmap.md)) and a priority:
**M** = must for GA · **S** = should for GA · **L** = later.
Acceptance criteria (AC) are written so they can become tests directly.

Surfaces: **C** = platform console · **A** = `/apply` · **St** = `/student` · **W** = `/staff` workspace · **P** = public (`/verify`, landing).

---

## 0. Shared capabilities (every module)

| Feature | Pri | AC |
|---------|-----|----|
| Bulk import (CSV/XLSX) with template download, async validation, **preview**, row-level error report, commit | M | Invalid rows never commit. Re-uploading the same file is idempotent. Imports of 50k rows finish in < 5 min |
| Export (CSV/XLSX/PDF) as an async job for large data sets | M | Export is authorised by the same permission as viewing. Exports are audited |
| Saved filters, server-side pagination, search | M | |
| Printable views (A4 print CSS) for slips, dockets, receipts, broadsheets | M | |
| Activity/audit timeline on key records (student, score sheet, invoice) | M | |

## 1. Platform console (C) — `[PHASE 1]`

| Feature | Pri | Notes / AC |
|---------|-----|-----------|
| Platform staff auth: password + **mandatory** TOTP/WebAuthn, IP allowlist, session list/revoke | M | Login without MFA is impossible. Console host is unreachable from non-allowlisted IPs (edge rule) |
| Tenant registry: create, edit profile, branding (logo, colors), type/ownership | M | |
| **Provisioning** job: shard placement, seed roles/settings/grading scheme, subdomain + TLS, first institution admin invite | M | Idempotent. Resumable from the failed step. Every step is logged |
| Custom domain onboarding (TXT verification → on-demand TLS) | S | Unverified domains never get certificates |
| Lifecycle: suspend (reason) / resume / offboard (60-day export window, warning emails at 45/30/14/7/1 days) / archive / purge | M | Suspended tenant: all tenant logins get 423 with a message. Purge needs 2 platform staff (two-person rule) |
| Tenant data export (full, for portability/offboarding) | M | Encrypted archive with a short-lived link |
| Shard management & pool → dedicated promotion | S | |
| Migrations runner dashboard (per shard status) | M | |
| Plans, subscriptions, platform invoices, usage (active students) | S | |
| **Product entitlements per tenant** (ADR-020) + feature flags | M | Disabling a product makes its routes 404 and skips its jobs for that tenant, server-side. Changes are audited |
| Platform announcements, incident and maintenance notices **to IT Admins** (in-app banner + email) | M | Targeted per tenant or all. Delivery is logged |
| **IT Admin ↔ UniVarse support channel**: tenant tickets with SLA timers, two-way messages, attachments | M | Only IT Admins (and roles they delegate) can raise platform tickets. Every message is logged on both sides |
| Platform health overview (links to Grafana), per-tenant usage | S | |
| **Support access ("break-glass")**: time-boxed, reason-logged, tenant-visible read-only access | S | Access expires in ≤ 4h. Tenant admin is notified. Every action is audited as `platform:{user}` |

## 2. Identity & access (W, St, A) — `[PHASE 0]`

| Feature | Pri | AC |
|---------|-----|----|
| Login by email / matric no. / staff no. / application no. + password | M | Generic error messages. Progressive delays and lockout ([08](08-security.md)) |
| **Account activation** for imported users via OTP to email/phone on record (no default passwords) | M | Imported users can't log in until activated |
| Password reset (email/SMS OTP), breached-password check | M | |
| MFA (TOTP) enrolment. **Required** for roles with approval/finance/admin permissions | M | Role assignment that requires MFA forces enrolment at next login |
| WebAuthn/passkeys | L | |
| Session management (list/revoke own sessions; admin revoke user sessions) | M | |
| Roles & permission catalog. Custom roles | M | |
| Role assignments with scope and validity dates (acting HOD, tenure) | M | Assignment outside validity has no effect. Changes invalidate the permission cache immediately |
| Step-up re-authentication for sensitive actions | M | |
| User directory & profile (photo, contact update with OTP verification) | M | |
| Delegation (HOD delegates approval while away) | S | Implemented as a time-bound role assignment with reason |

## 3. Institution setup (W: institution admin) — `[PHASE 2]`

| Feature | Pri | AC |
|---------|-----|----|
| Org tree: colleges/faculties/departments/admin units, drag to re-parent | M | Can't delete a unit with programmes/students. Archive instead |
| Staff import & profiles, role assignment in bulk | M | |
| Settings UI for every `[CONFIG]` key, grouped, with defaults and help text | M | Changes are audited. Changes to grading/approval settings need step-up |
| Integrations: payment gateways (keys encrypted, test/live), SMS sender ID, email from-address | M | Secrets are never shown back after save (write-only) |
| Branding: logo, colors, institution letterhead for documents | M | |
| **Product enablement** by the IT Admin within the institution's plan | M | Only products in the plan can be enabled. Enabling or disabling is audited and takes effect on the next request |
| **IT Admin guardrails** ([01 §5.4](01-product-brief.md)) | M | Tests prove IT Admins can't read secrets, edit/disable audit, weaken platform security baselines (e.g. MFA for privileged roles) or reach other tenants |
| Setup checklist/wizard (go-live readiness) | S | |

## 4. Curriculum — `[PHASE 2]`

| Feature | Pri | AC |
|---------|-----|----|
| Programmes (award, duration, entry modes, min units) | M | |
| Course catalog (import), course equivalences | M | Course code unique per tenant |
| Curriculum versions per programme: level × semester items, categories, elective groups, prerequisites | M | An approved version is read-only. Edits create a new draft version |
| Curriculum approval (HOD → Dean) | S | |
| Curriculum compliance view (units per level vs CCMAS minimums) | L | |

## 5. Academic calendar — `[PHASE 2]`

| Feature | Pri | AC |
|---------|-----|----|
| Sessions & semesters, activation | M | Only one active each. Activation is audited |
| Windows (registration, late reg, add/drop, fee payment, score entry, hostel, clearance) with optional scope overrides | M | Window checks use server time in `Africa/Lagos` |
| Session rollover wizard (promote levels, create offerings from curricula, generate fee invoices) | M | Dry-run preview first. Idempotent |
| Public academic calendar page | S | |

## 6. Admissions (A, W) — `[PHASE 3]`

| Feature | Pri | AC |
|---------|-----|----|
| Admission cycles with configurable form (fields, required documents) per entry mode | M | |
| Applicant portal: account, biodata, JAMB details, O'level sittings, DE qualifications, uploads, form fee payment, submission, status tracking, printable acknowledgement | M | Can't submit without the form fee paid. Uploads are virus-scanned |
| Import JAMB candidate list (CSV from CAPS) and UTME scores | M | Matches by JAMB reg no. Mismatches are reported |
| Import Post-UTME/CBT scores | M | |
| O'level verification workflow (manual; optional provider integration) | M | |
| Aggregate computation & **merit lists** per programme with quotas | M | Deterministic ranking given the same inputs. Explainable per candidate |
| Admission decisions, CAPS recommendation export, CAPS status re-import | M | |
| Offers, admission letters (PDF with QR), acceptance + acceptance fee | M | |
| Document screening/verification (online + physical desk) | M | |
| **Enrolment**: create student, matric number, student role, fee invoice | M | Exactly-once per accepted, verified applicant |
| Supplementary admissions & change of programme | S | |
| Admission analytics (applicants per programme, cut-offs, quota fill) | S | |

## 7. Student records (W, St) — `[PHASE 4]`

| Feature | Pri | AC |
|---------|-----|----|
| Student profile (biodata, programme, level, status, standing, documents) | M | Sensitive fields visible only with `records.student.view_sensitive` |
| Historical student import (legacy students + legacy results) | M | Legacy results are imported as `CourseResult` with source=`LEGACY_IMPORT` and approvals recorded |
| Status changes (deferment, suspension, rustication, withdrawal, reinstatement) with reasons & documents | M | |
| Programme transfer with course crediting | S | |
| Biodata change requests (name change with evidence) | S | Approved changes are audited. Old values are kept |
| Student ID card data export / printing | L | |

## 8. Bursary / finance (W, St, A) — `[PHASE 3]`

| Feature | Pri | AC |
|---------|-----|----|
| Fee items & fee schedules with rule matching, instalments, approval | M | Rule overlap detected at approval |
| Invoice generation (bulk at session start; on-demand for applicants, transcripts, hostel) | M | |
| Pay online: Paystack / Flutterwave / Remita (RRR), payment status page, retry | M | Payment is credited only after verification/webhook. Double callbacks never double-credit |
| Student account statement (ledger), printable | M | |
| Receipts with QR verification | M | |
| Manual payment recording (bank teller) with evidence and approval | S | Requester ≠ approver |
| Waivers & scholarships | M | |
| Refunds | S | |
| Daily reconciliation with gateway reports; exceptions queue | M | |
| Reports: collections by fee item/programme/date, outstanding debtors, TSA revenue codes | M | |

## 9. Course registration (St, W) — `[PHASE 4]`

| Feature | Pri | AC |
|---------|-----|----|
| Offerings generated from curricula each semester. Lecturer allocation by HOD | M | |
| Student registration: pre-populated compulsory + carryovers, elective selection, live unit counter, rule validation, submit | M | All rules in [04 §5](04-business-rules.md) enforced **server-side** |
| Adviser approval queue (bulk approve, return with comment) | M | |
| Printable course registration form (with QR) | M | |
| Add/drop during window | M | |
| Late registration with automatic penalty | S | |
| Class lists per offering (export) | M | |

## 10. Examinations (W, St) — `[PHASE 5]`

| Feature | Pri | AC |
|---------|-----|----|
| Venues & capacities | M | |
| Exam timetable builder (drag-and-drop), conflict detection (student clash, venue capacity, invigilator double-booking), auto-suggest | M | Save is blocked on hard conflicts. Warnings shown for soft ones |
| Invigilator assignment & workload view | S | |
| Eligibility (registration approved, fee threshold, attendance ≥ 75% `[CONFIG]` if attendance enabled) | M | |
| Exam docket (PDF + QR) | M | Only for eligible students |
| Student & staff timetable views, ICS export | S | |
| Malpractice cases | S | |
| Attendance capture | L | |

## 11. Results (W, St) — `[PHASE 5]`

| Feature | Pri | AC |
|---------|-----|----|
| Assessment schemes per offering | M | |
| Score entry grid (keyboard-friendly, autosave drafts, offline-tolerant) + CSV upload with preview | M | Validation per component max. Optimistic locking prevents lost updates |
| Submit → HOD → Faculty → Senate → Publish workflow with comments, bulk actions | M | SoD enforced. Every transition is audited with a snapshot hash |
| Broadsheet (department/level/semester) and mastersheet views + PDF/XLSX export | M | Numbers match the engine exactly (property + fixture tests) |
| Result statistics per course (distribution, pass rate, mean) shown to approvers | M | |
| Publication with staggered notifications | M | |
| Student result view: per semester, GPA/CGPA, standing, outstanding courses, printable statement of result | M | Student sees only `PUBLISHED` (or provisional if enabled) |
| Result amendments with approvals | M | |
| Standing computation & probation/withdrawal recommendations list | M | |
| Legacy result import | M | |

## 12. Clearance, graduation, transcripts, NYSC (St, W, P) — `[PHASE 6]`

| Feature | Pri | AC |
|---------|-----|----|
| Clearance templates & cases; officer queues per unit; auto-checks (bursary, hostel) | M | |
| Degree audit per student & per class | M | Every failed rule is explained |
| Graduation list: generate eligible candidates, faculty approval, Senate approval, class of degree | M | Approved list sets `GRADUATED` status |
| Transcript requests: type, destination, fee, tracking | M | |
| Transcript generation (PDF, letterhead, signatures, QR, hash) | M | Regenerating produces identical content for the same data |
| Public verification portal (`/verify/{code}`): shows minimal details and a valid/revoked status | M | Rate-limited. No enumeration. Shows only what the document shows |
| Certificates data / printing | S | |
| NYSC mobilisation list export in the required format | M | `[VERIFY]` format with NYSC each cycle |

## 13. Hostel (St, W) — `[PHASE 7]`

| Feature | Pri | AC |
|---------|-----|----|
| Hostels/rooms/bed spaces setup and import | M | |
| Allocation rounds with eligibility & priority rules | M | |
| Student application & auto/manual allocation, hold with expiry, payment confirmation | M | No double allocation under concurrency (tested) |
| Check-in / check-out, damages → clearance | S | |
| Occupancy reports | S | |

## 14. Communications (all) — `[PHASE 7]` (basic notifications from Phase 0)

| Feature | Pri | AC |
|---------|-----|----|
| Template-based email/SMS with tenant branding | M | |
| In-app notifications center | M | |
| Announcements with audience targeting (roles, faculties, levels) and scheduling | M | Rich text sanitized server-side |
| Notification preferences (non-critical only) | S | |
| SMS cost tracking per tenant | S | |

## 15. Helpdesk (St, W) — `[PHASE 7]`

| Feature | Pri | AC |
|---------|-----|----|
| Tickets by category routed to units. **Technical issues route to the institution's IT Admin** ([01 §5.3](01-product-brief.md)) | M | End users can't open platform tickets directly |
| SLA, assignment, canned responses, attachments | S | |
| **Escalation by the IT Admin to UniVarse** (creates a linked platform ticket; replies sync back) | M | The link and every message are logged on both sides |

## 16. Reporting & analytics (W, C) — `[PHASE 7]`

| Feature | Pri | AC |
|---------|-----|----|
| Role-aware dashboards (management, dean, HOD, bursary, admissions) | M | Data scoped to the viewer's scopes |
| Standard reports: enrolment by programme/level/sex/state, results statistics, graduation outcomes, revenue | M | |
| NUC-style statistical returns export | S | `[VERIFY]` current templates |
| Scheduled report emails | L | |

## 17. Audit & compliance (W, C) — `[PHASE 0]` onward

| Feature | Pri | AC |
|---------|-----|----|
| Audit log viewer with filters, export | M | Only for `audit.view` holders. Viewing the audit log is itself audited |
| Audit hash-chain verification tool | M | Detects any modified/deleted row |
| Data subject request handling (access export, rectification) | M | [16](16-compliance-ndpa.md) |
| Retention jobs per data class | M | |

## 18. Teaching & Learning (St, W) — `[PHASE 4b]`

A product of its own ([01 §5.1](01-product-brief.md)). It can be enabled without Assessment, and vice versa. Class lists come from `registration` (events/contract), never by reading its tables.

| Feature | Pri | AC |
|---------|-----|----|
| **Course space** per course offering: overview, schedule, lecturers, enrolled students (from the approved registration) | M | Membership follows registration add/drop within minutes (event-driven). Dropped students lose access |
| Materials: files (virus-scanned), links, embeddable content, ordered by week/topic, visible from a date | M | Files are served via short-lived presigned URLs, only to members. Downloads are logged for sensitive materials |
| Course announcements (email/SMS/in-app via `comms`) | M | |
| **Live lecture engagement** ([PHASE 4b], `realtime` role): QR / short-code **attendance check-in**, **live polls**, moderated **Q&A** | M | Attendance codes rotate every ≤ 30 s and are bound to the live session (anti-sharing). 500 concurrent participants: poll/Q&A round-trip p95 ≤ 1 s. Falls back to HTTP polling if WebSocket is unavailable |
| Attendance records feed exam eligibility (docs/04 §5 attendance rule) | S | |
| **Assignments**: instructions, due date, late policy, file/text submissions, plagiarism-check hook (`[VERIFY]` provider later) | M | Submissions are immutable once submitted (resubmission creates a new version while the window is open). Server time decides lateness |
| Marking: rubric or score, feedback, release of marks | M | Released assignment marks can feed a score-sheet CA component (same contract as CA tests). Changes after release are audited |
| Discussion forum per course | L | |
| Video lectures: **integrate** (Google Meet/Zoom/Jitsi links + recordings as materials), not build | S | |
| 3D virtual labs for practical-heavy courses | **Deferred** | Embeddable sandboxed content keeps the door open ([01 §5.5](01-product-brief.md)) |

## 19. Assessment — CA CBT (St, W) — `[PHASE 4b]`

Continuous assessment only. **Examinations are out of scope** (deferred; [01 §5.5](01-product-brief.md)). Scores reach `results` only through the `assessment.ca_scores_released` event, mapped to an `AssessmentScheme` CA component.

| Feature | Pri | AC |
|---------|-----|----|
| **Question bank** per course: MCQ (single/multiple), true/false, numeric (tolerance), short text, essay; tags, difficulty, versioning | M | Editing a question used in a published test creates a new version. Past attempts keep the version they saw |
| **CA test definition**: window, duration, attempts (default 1), pool rules (N from tag/difficulty), shuffle questions and options, show-results policy, accommodations (extra time per student) | M | Publishing **pre-generates** each candidate's paper (seeded), so start-time load is a read, not a computation |
| Eligibility: registered for the offering (and optional fee/attendance gates) | M | Ineligible students see why. Gates are `[CONFIG]` |
| **Taking a test**: server-authoritative timer, autosave per answer, **resume after disconnect** with the remaining time, auto-submit at time-out | M | No answer acknowledged by the server is ever lost (crash/reconnect tests). Answers are idempotent (`attemptId` + `questionId` + revision). Submission is exactly-once |
| **Integrity logging** (not automatic punishment): device/IP changes, focus loss / tab switches, paste events, abnormal answer timing, concurrent sessions | M | Events are recorded in an append-only attempt log and summarised for the lecturer. **No automatic penalties.** Humans decide, and decisions are audited |
| Anti-impersonation: one active session per attempt, optional photo check at start (lecturer compares to the profile photo) | S | A second device taking over the attempt is logged and requires lecturer unlock |
| **Marking**: objective items auto-marked at submit. Essays/short text manually marked with a rubric. Regrade on answer-key correction | M | A key correction re-marks all affected attempts, with old and new scores audited |
| **Release to results**: lecturer releases CA scores → `assessment.ca_scores_released` → score-sheet CA component | M | Only while the score sheet is editable (`DRAFT`/`RETURNED`). Released scores are versioned. Changes after release follow the amendment path |
| Item analysis (difficulty, discrimination, distractor stats) | S | |
| Peak load: **2,000 candidates starting within 60 s** | M | Load test is a release gate: zero lost answers, start p95 ≤ 2 s, error rate < 0.1%, and other products' p95 within SLO (ADR-020) |
| CBT for examinations, venue lockdown browser | **Deferred** | The engine is built exam-capable (sessions, venues, integrity logs) |
