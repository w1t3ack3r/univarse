# Spec 0040: Phase 2, institution setup: slices and decisions

**Status:** **Approved by the owner on 2026-11-26, all as written:** Q1 to Q16, the threat rows T40 to T45, ADR-039 and the re-estimate (about 9 to 11 weeks).
**Phase:** 2 ([18](../18-roadmap.md)): "Institution setup (~6 wks)".
**Builds on:**

- **The owner's Phase 2 guidance documents (2026-11-26), kept locally and not in the repository:**
  - two draft Phase 2 specifications, one for universities and one for polytechnics;
  - three reference baselines of Nigerian institutional structure: universities, polytechnics, and colleges of education (with NCCE's 2026 dual mandate).

  This spec turns them into slices and decisions. Where they make a recommendation, it is taken unless a decision below says otherwise.
- [05 §3–§5](../05-modules-and-features.md): institution setup, curriculum and the academic calendar;
- [03 §3–§5](../03-domain-model.md): `OrgUnit`, `StaffProfile`, `Programme`, `Course`, `CurriculumVersion`, `AcademicSession`;
- [04](../04-business-rules.md) §6 (progression), §11 (identifiers), §13 (time and calendars), §15 (rollover);
- [ADR-028](../19-decision-log.md): the `ORG_UNIT` and `PROGRAMME` scopes arrive with Phase 2;
- [spec 0034](0034-provisioning.md): the institution templates (`university`, `polytechnic`, `college-of-education`), today identical in content;
- [spec 0025](0025-phase-1-control-plane.md) E17 and E21: the training sandbox and the import monitor;
- the invariants: tenant isolation, scope against the loaded resource, decimals for scores, rules in `packages/domain`, **institution differences as settings, never `if (tenant === …)`**, immutable records, audit and outbox in one transaction.

## Why

Phase 1 built the platform's control room; an institution can now be provisioned, run, suspended, offboarded and placed on a pool or its own database. But inside its own workspace there is almost nothing yet: one root unit, its users and its settings. Every product after this phase needs the institution's academic structure:
- admissions offer a **programme**;
- registration follows a **curriculum** inside a **window**;
- results are for **courses** in a **session**;
- fees follow the programme and the level;
- matric numbers carry **unit codes**.

Phase 2 builds that structure, and the staff who run it. It is the first domain phase, and its data model is the one every later product points at, often from append-only records. A mistake here is the most expensive kind to fix later, so the phase starts with its decisions.

## What exists today, and what the owner's documents change

| Area | Exists | What the documents add |
| --- | --- | --- |
| Org tree | `org_unit` with a fixed `kind` (`ACADEMIC`/`ADMINISTRATIVE`) and `type` enum (`INSTITUTION` … `UNIT`), a materialised path, status; provisioning seeds the root | Configurable unit types and names per institution, templates per institution type, an accessible "Move unit", archiving, leadership, **effective-dated history**, **codes locked once used in a matric number** |
| Staff | `user_account`, `role`, `role_assignment` (six scope types, only `INSTITUTION` enforced, ADR-028) | Staff **category, cadre, rank, grade**; **offices and appointments** (HOD, Dean, Director, coordinators) with dates; employment type and status; governance bodies and their membership. Rank, office and membership are separate things |
| Programmes, courses | Not built ([03 §4](../03-domain-model.md) only) | Qualification families per institution type (B.Sc. … Ph.D.; ND, HND, NID; NCE, B.Ed., PGDE); one primary owning department with optional participants; ND → HND as a formal relationship, not a promotion; programme options and **NCE subject combinations**; accreditation records (NUC, NBTE, NCCE). Courses: classifications as **tags**, contact hours by component (theory, practical, workshop, laboratory, studio, fieldwork), configurable level labels, approved equivalences |
| Curriculum | Not built | Versions **by admission cohort**, immutable once published; elective groups with minimum and maximum rules; **prerequisite rules**; a configurable approval chain (HOD → Dean → Senate or Academic Board) with external approval (NBTE, NUC, NCCE) recorded separately; SIWES, practical, project and Teaching Practice **requirements** as configuration |
| Calendar | Not built ([04 §13](../04-business-rules.md) only) | Session lifecycle, semesters and special periods (a SIWES period), more window types, overrides with **programme > department > school/faculty > institution** precedence, and "the window that applies to this student" |
| Rollover | [04 §15](../04-business-rules.md): promote, carry over, flag spillovers | **Framework first**: student progression and carry-forward wait for student records and results, with no placeholder records |
| Institution types | `Tenant.type` (`UNIVERSITY`/`POLYTECHNIC`/`COLLEGE_OF_EDUCATION`) and three templates; [01 §3](../01-product-brief.md) puts polytechnics and colleges of education **post-GA** | All three are designed for now, on one shared academic core with institution-type profiles (Q1, ADR-039) |

## Decisions for approval

| # | Decision | Recommendation, and why |
| --- | --- | --- |
| Q1 | **Polytechnics and colleges of education move into scope from Phase 2,** on the same academic core as universities. [01 §3](../01-product-brief.md) changes from "post-GA" to "supported from Phase 2, with their type-specific operations (SIWES placements, Teaching Practice placements, laboratories) in later phases". **Private universities stay the launch market and pilot.** | The owner's documents design all three together, and provisioning already offers their templates. Designing the core for one type and retrofitting two would rebuild the data model every later product depends on. |
| Q2 | **The org hierarchy is flexible.** Each institution configures its unit types (college, faculty, school, institute, centre, department, directorate, division, unit, section, with its own names: "School" or "Faculty"), seeded from its type's profile. Any type may contain any other, except the rules below. | Universities, polytechnics, monotechnics and colleges of education organise differently, and none fits one fixed sequence (the documents' first decision). **Refined by [spec 0041](0041-institution-profiles.md) Q2 (2026-11-26):** each unit type has hierarchy rules, the types it may contain, seeded from the profile and editable in S1. |
| Q3 | **A programme has one primary owning department, and optional participating departments,** with one coordinator. | Interdisciplinary programmes exist; one owner keeps authority and scope simple (the documents' second decision). |
| Q4 | **A curriculum applies by admission cohort.** A published version is immutable; a change is a new draft copied from it, approved and published, and the old one stays. A student stays on their cohort's version; moving one is an explicit, authorised migration (a later phase), never automatic. | The documents' third decision, and the platform's own rule on immutable records. |
| Q5 | **The curriculum approval chain is configurable per institution,** a list of stages each held by an office or a governance body. Defaults by type: **universities HOD → Dean (→ Senate, if switched on); polytechnics and colleges of education HOD → Dean → Academic Board.** External approval (NUC, NBTE, NCCE) is recorded as its own event and never stands in for internal approval, or the reverse. Return for correction, rejection with a reason, resubmission and the full history are kept. | The documents' fourth decision; their polytechnic and college-of-education baselines put the Academic Board last. |
| Q6 | **Rollover is framework first.** Phase 2 builds the orchestrator (stages, dry run, explicit confirmation, idempotency key, execution record, resumable, every stage audited) and its Phase 2 operations: create the next session and its periods, configure windows, validate programmes and curricula, activate. **Student progression, carry-forward and duration flags are registered as operations later,** when student records (Phase 4) and results (Phase 5) exist. [04 §6](../04-business-rules.md)'s default ("promote regardless of carryovers") stays a configurable progression **rule** evaluated per student, never a blanket promotion. | The documents' fifth decision. No placeholder student or invoice records. |
| Q7 | **The staff model in Phase 2:** staff profile; staff category, cadre, rank and grade from per-institution catalogues (seeded by type); **offices and appointments** with start and end dates (an appointment to an office grants that office's role, scoped to its unit or programme, for its dates); employment type and status; governance bodies and their membership. **Later:** promotion history and criteria, payroll and grade progression, full committee management, appointment eligibility rules. | Offices drive authority (an HOD's power over a department) and approval chains, so Phase 2 needs them. A full HR module isn't on the roadmap; promotions and payroll can follow without reshaping this. |
| Q8 | **Colleges of education are configured in Phase 2:** NCE and approved degree programmes side by side (the dual mandate), **subject combinations**, and Teaching Practice **requirements** in the curriculum. Teaching Practice placements and assessments are a later phase, as SIWES operations are. | Provisioning already offers the type; its core differences are data, not operations. |
| Q9 | **Regulatory specifics are reference data marked `[VERIFY]`, never universal rules:** NBTE's curriculum proportions, SIWES durations, the 2024 Scheme of Service, HOD rank requirements, CCMAS minimums. The compliance views (CCMAS, NBTE, NCCE) are a later enhancement that records the edition it checked against. | The documents themselves say these must be validated against the approved curriculum and law, and vary by ownership. |
| Q10 | **Institution types are profiles of data (ADR-039).** The templates grow from settings into profiles: unit types and names, level labels, qualification families, staff categories, cadres and ranks, governance bodies, approval chain defaults, window and period types. Provisioning copies the profile into the institution, which then owns and edits its copy. Rules that differ by qualification (ND → HND, NCE combinations) are pure functions in `packages/domain` selected by the **qualification's** configuration, never by the tenant or its type. | The documents' "shared core with adapters", within invariant 4: the adapters become data and rule modules, and a dual-mandate college runs NCE and degree rules side by side. |
| Q11 | **A unit's code is locked once it has been used in an issued identifier.** A changed code is a new code, with the old one kept in the unit's history; issued matric numbers store the codes they were issued with ([04 §11](../04-business-rules.md)). Phase 2 builds the lock and its history; Phase 3 issues the first matric numbers. | Restructuring never rewrites a student's identity (the documents' matric rule). |
| Q12 | **Organisational change is effective-dated.** Creating, renaming, moving, archiving and a code change are recorded with the date they take effect; the tree "as at a date" can be read. Units with programmes, staff, students or history are archived, never deleted; an archived unit takes no new active child; a unit can't become its own ancestor. | Transcripts, staff history, accreditation and audits need the structure as it was. |
| Q13 | **One generic import framework:** upload (through the file scanner) → validate → preview with each row's errors → commit, idempotent and resumable, in batches, audited, per entity. Org units, staff, programmes, courses and curricula are its first importers; later phases add theirs (JAMB lists, legacy students and results, fee schedules). Error reports never put a value in a log, and spreadsheets it writes are safe against formula injection. | The roadmap's framework, used by every later module; the pilot's spreadsheets are its exit test. |
| Q14 | **Scopes (ADR-028):** `ORG_UNIT` is checked against the loaded resource's unit path (a grant on a faculty covers its departments); `PROGRAMME` against the programme, and an `ORG_UNIT` grant covers the programmes its units own. Out of scope answers 404. Positive and negative tests for every scoped permission. | ADR-028's deferred scopes, with their first consumers. |
| Q15 | **Prerequisites are rules, not a column:** pass a course, pass one of several, complete a course, a minimum of credit units, a completed level, combined with AND and OR. A pure evaluator in `packages/domain`, with a fixture set; Phase 2 stores and validates them, and registration (Phase 4) evaluates them. | The documents' prerequisite section; a single `prerequisite_course_id` can't express Nigerian curricula. |
| Q16 | **Re-estimate: about 9 to 11 weeks,** in the slices below, and **Phase 1b still follows Phase 2**, before Phase 3. | The documents widen the phase (the staff model, three institution types, prerequisite and elective rules, history). Phase 1 ran about twice its first estimate. |

## The slices

Each slice gets its own spec before it is built, as in Phase 1.

| Slice | What it delivers | Size |
| --- | --- | --- |
| **P2-S0** Phase start | The threat rows T40 to T45; ADR-039; the institution-type profiles as versioned data (unit types, level labels, qualification families, staff catalogues, governance bodies, approval defaults, window types), with provisioning copying them | S |
| **P2-S1** The org tree | Unit types and names; create, edit, move (drag-and-drop and an accessible "Move unit"), archive; effective-dated history and "as at"; code locks (Q11); leadership through offices (S3); **`ORG_UNIT` scope** | M–L |
| **P2-S2** The import framework | The engine (Q13), its first importer (org units), the institution's import screens; each import's progress and counts mirrored to the platform for the console (S8) | M |
| **P2-S3** Staff | Profiles; categories, cadres, ranks and grades; offices and appointments granting scoped roles for their dates; employment type and status; governance bodies and membership; bulk staff import with activation invites | L |
| **P2-S4** Programmes and courses | Qualification families; programmes (ownership, durations, entry modes including HND admission as its own route, options and subject combinations, accreditation records, ND → HND links); the course catalogue (tags, contact hours, level labels); approved equivalences; **`PROGRAMME` scope** | L |
| **P2-S5** Curricula | Versions by cohort; levels × periods; items; elective groups and their rules; prerequisite rules (Q15); SIWES, Teaching Practice, project and practical requirements; the configurable approval chain (Q5), external approvals; immutability enforced in the database; a new draft by copy | L |
| **P2-S6** Calendar and rollover | Sessions and their lifecycle; semesters and special periods; windows with overrides and precedence; "the window for this student"; server time in `Africa/Lagos`; the rollover orchestrator (Q6) with its Phase 2 operations | M–L |
| **P2-S7** Settings, integrations, branding | A screen for every `[CONFIG]` key, grouped, with defaults and help, grading and approval changes with step-up; integrations (gateway keys, SMS sender, email from-address) write-only and envelope-encrypted; the letterhead; the IT Admin guardrails ([05 §3](../05-modules-and-features.md)); the setup checklist | M |
| **P2-S8** The console | A training sandbox per institution (its configuration in a tenant of its own, with made-up data; an item on the go-live checklist) and the import monitor (progress and error counts, never rows) | M |

## New threats

| # | Threat | Vector | Controls |
| --- | --- | --- | --- |
| T40 | **A published curriculum is changed after students are bound to it** | A privileged user, or a bug, edits an approved version; graduation checks then judge a cohort against rules it never had | Published versions are immutable in the database (a trigger, as for results); changes only through a new draft and the approval chain; every stage audited with its approver; step-up to approve |
| T41 | **Authority widens through the structure** | A unit moved under another faculty silently gives its Dean authority; an appointment outlives its term; an office holder approves their own submission | Moves and appointments need the structure permission and step-up, and are audited with their effective dates; scope is checked against the loaded resource at the time of the request; appointments end on their date; an approver can't decide their own submission |
| T42 | **A bulk import becomes the attack** | A malicious file, mass account creation, formula injection in a spreadsheet re-opened by staff, personal data in error reports | Uploads through the scanner and type checks; preview before commit; row limits per import; staff imported in `PENDING_ACTIVATION` with invites (no passwords); error reports hold codes and row numbers, never values in logs; exported spreadsheets neutralise formulas; the console sees counts only |
| T43 | **Integration secrets leak** | A gateway key shown back, logged, exported or read by an IT Admin | Write-only: envelope-encrypted under the institution's key, never returned or logged, masked in the UI; setting one needs step-up and is audited; the IT Admin guardrails' tests |
| T44 | **A calendar window is reopened or bent** | A client clock, an override that silently reopens registration or score entry, a back-dated change | Windows judged on server time only; overrides are scoped, audited with who and why, and shown in the "window for this student" view; changes to an open or closed window of score entry or registration need step-up |
| T45 | **An identifier loses its meaning** | A unit's code changed after matric numbers were issued with it; an equivalence inferred from a similar course name | Locked codes (Q11) with history; issued identifiers store their snapshot; equivalences only by explicit, approved decision, never inferred |

## Acceptance (the phase's exit)

1. **J2 E2E green:** import org units, staff, programmes, courses and a curriculum; approve and publish the curriculum through its chain; create and activate a session and semester with windows; desktop and phone, with axe.
2. **A pilot institution's real spreadsheets (anonymised)** import its structure, programmes, courses and curricula **without code changes**.
3. **All three institution types provision** from their profiles, and a dual-mandate college of education holds NCE and degree programmes side by side.
4. **Every new route declares its permission; `ORG_UNIT` and `PROGRAMME` scopes** have positive and negative tests against the loaded resource; out of scope is 404.
5. **A published curriculum can't be changed** by any role, through the API or the database; an approval can't be made by its submitter.
6. **The rollover's dry run changes nothing,** its execution is idempotent and resumable, and every stage is audited.
7. **Integration secrets never come back** from any route, log or export.
8. Released, deployed and checked on the stack by the owner.

## The owner's steps

- Approve or change Q1 to Q16, T40 to T45, ADR-039 and the re-estimate.
- **Provide anonymised spreadsheets from a pilot institution** (its units, programmes, courses and a curriculum), as early as possible: they shape the import framework from its first slice.
  - **Received 2026-11-26: a synthetic stand-in** for a fictional private university, kept locally (not in the repository): faculties and departments, a programmes export, the course catalogue, curricula in several layouts, an anonymised staff list and a handbook extract, with deliberate real-world messiness and an answer key. It builds and tests the importer (P2-S2 on); **it can't satisfy acceptance 2**, which still needs a real institution's files.

## Affected docs (updated with this spec)

[00](../00-glossary.md) (the new terms), [01 §3](../01-product-brief.md) (polytechnics and colleges of education in scope, Q1), [03 §3–§5](../03-domain-model.md) (the planned entities), [04](../04-business-rules.md) (§6's progression rule, a curriculum by cohort, equivalences, window precedence, the code lock), [05 §3–§5](../05-modules-and-features.md) (the features and acceptance criteria), [08](../08-security.md) (T40 to T45), [12](../12-testing-strategy.md) (J2), [18](../18-roadmap.md) (Phase 2's slices and re-estimate), [19](../19-decision-log.md) (ADR-039).

## Out of scope (later phases)

- **Student operations in rollover:** progression, carry-forward, duration flags (Phases 4 and 5 add them as operations).
- **SIWES and Teaching Practice operations:** placements, organisations, supervisors, logbooks, assessments.
- **Laboratories, workshops and equipment.**
- **HND admission processing** (Phase 3's admissions), **course offerings** (Phase 4), **fee invoices** (Phase 3).
- **Promotions, grades and payroll; full committee management; appointment eligibility rules.**
- **Curriculum migration** of a student between versions; **the compliance views** (CCMAS, NBTE, NCCE).
