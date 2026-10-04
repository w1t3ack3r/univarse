# 04 — Business Rules (Nigerian Academic Regulations)

These rules drive the domain engines in `packages/domain`. **Practice varies by institution and changes over time.** Every rule below is a `[CONFIG]` tenant setting with the listed default unless it says otherwise. Before a tenant goes live, its Senate-approved *Students' Handbook / Academic Regulations* MUST be mapped onto these settings and recorded as **golden test fixtures** ([12](12-testing-strategy.md) §4).

> `[VERIFY]` Defaults reflect common NUC-aligned practice. Confirm them against the pilot institution's regulations and the current NUC CCMAS guidance.

---

## 1. Grading

### 1.1 Default grading scheme (5-point)

| Score | Grade | Grade point | Pass? |
|-------|-------|-------------|-------|
| 70–100 | A | 5 | ✔ |
| 60–69 | B | 4 | ✔ |
| 50–59 | C | 3 | ✔ |
| 45–49 | D | 2 | ✔ |
| 40–44 | E | 1 | ✔ `[CONFIG]` |
| 0–39 | F | 0 | ✘ |

- Some institutions have **removed the E grade** (pass mark 45). Model this as a *different grading scheme*, never as an edit to the existing one.
- **Grading schemes are pinned by cohort.** A student keeps the scheme that was in force at their admission (`Student.gradingSchemeId`) unless the tenant explicitly migrates the cohort. Migrating a cohort is an audited platform operation.
- A scheme becomes **immutable** once any `CourseResult` references it.

### 1.2 Score composition
- `total = Σ continuous-assessment components + exam score`. Each component is capped at its maximum, and the maximums sum to 100 (`AssessmentScheme`). Default: CA 30, Exam 70.
- **Rounding of totals** `[CONFIG results.scoreRounding]`: default **round half up to an integer** before grading (69.5 → 70 → A). Alternatives: truncate, or no rounding (grade on the decimal).
- Entries are stored as `numeric(5,2)`. Never use floats.

### 1.3 Remark codes `[CONFIG]`

| Code | Meaning | Default grade treatment |
|------|---------|------------------------|
| `ABS` | Absent from exam without approval | Treated as **F (0 GP)**, counts in GPA |
| `INC` | Incomplete (approved absence / deferred exam) | **Excluded** from GPA until resolved; shows as pending |
| `SICK` | Approved medical absence | Excluded; deferred exam |
| `MAL` | Exam malpractice under investigation | Result withheld (excluded) until the case is decided |
| `NR` | Result not received | Excluded; flagged on broadsheet |

Outstanding `INC/SICK/MAL/NR` codes MUST be resolved before a student can be on a graduation list.

## 2. GPA and CGPA

### 2.1 Formulas
- **Credit points** for a course: `CP = CU × GP`.
- **GPA** (semester) = `Σ CP / Σ CU` over courses counted in that semester (including failed courses).
- **CGPA** = `Σ CP / Σ CU` over **all counted attempts** up to and including the semester.
- **Carryover treatment** `[CONFIG results.repeatPolicy]`: default **`ALL_ATTEMPTS_COUNT`**. The original F stays and the new attempt is added. Alternatives: `BEST_ATTEMPT`, `LATEST_ATTEMPT`.
- **Precision:** compute with exact decimals (`decimal.js`), and store `tcu`, `tcp` as integers and `gpa`, `cgpa` as `numeric(4,2)`.
- **Display/classification rounding** `[CONFIG results.gpaRounding]`: default **round half up to 2 dp**. Some institutions truncate (3.499 → 3.49). This matters at class boundaries, so it MUST be confirmed.
- Courses flagged `excludeFromGpa` (e.g. some GST/pass-fail courses `[CONFIG]`) count toward units earned but not GPA.

### 2.2 Worked example (fixture `gpa-basic-01`)

| Course | CU | Score | Grade | GP | CP |
|--------|----|-------|-------|----|----|
| CSC 101 | 3 | 72 | A | 5 | 15 |
| MTH 101 | 3 | 55 | C | 3 | 9 |
| PHY 101 | 2 | 38 | F | 0 | 0 |
| GST 111 | 2 | 64 | B | 4 | 8 |
| **Total** | **10** | | | | **32** |

GPA = 32 / 10 = **3.20**. PHY 101 becomes an outstanding carryover.
Next semester: PHY 101 is retaken (CU 2, B → 8 CP) with other courses totalling 14 CU / 50 CP. Under `ALL_ATTEMPTS_COUNT`: CGPA = (32 + 50 + 8) / (10 + 14 + 2) = 90 / 26 = **3.46**.

### 2.3 Engine contract
```ts
computeSemesterResult(input: {
  scheme: GradingScheme;
  policy: ResultPolicy;            // repeat policy, rounding, remark treatments
  priorCourseResults: CourseResult[];
  semesterCourseResults: CourseResult[];
}): { tcu; tcp; gpa; cumulativeTcu; cumulativeTcp; cgpa; outstanding: CourseRef[]; standing }
```
It is pure and deterministic. `engineVersion` is stored with each `SemesterResult` so historical numbers can be explained later.

## 3. Academic standing, probation and withdrawal

| Rule | Default `[CONFIG]` |
|------|--------------------|
| Good standing | CGPA ≥ 1.00 |
| **Probation** | CGPA < 1.00 at the end of a session |
| **Withdrawal** | CGPA < 1.00 at the end of the probation session (two consecutive sessions below threshold) → recommend withdrawal / change of programme (a human decision records the actual status change) |
| Standing evaluated | End of session (after second-semester results are published) |

The engine produces a **recommendation**. The status change (`WITHDRAWN`) needs an authorised human action with a reason. It's never automatic.

## 4. Degree classification

| Class | CGPA range (default) |
|-------|----------------------|
| First Class | 4.50 – 5.00 |
| Second Class (Upper) | 3.50 – 4.49 |
| Second Class (Lower) | 2.40 – 3.49 |
| Third Class | 1.50 – 2.39 |
| Pass | 1.00 – 1.49 `[CONFIG]` (abolished at some institutions) |

- Classification uses the **final CGPA after configured rounding** (§2.1).
- Professional programmes (MBBS, BDS, etc.) often don't classify. Set `programme.classifies = false` and the award text is used instead.
- Carryover-affected students: some institutions cap the class (e.g. no First Class if any course was repeated) `[CONFIG graduation.repeatClassCap]`, default: no cap.

## 5. Course registration

| Rule | Default `[CONFIG]` |
|------|--------------------|
| Minimum units per semester | 15 |
| Maximum units per semester | 24 |
| Final-year extra units | Up to 30 with HOD approval |
| Carryovers first | Outstanding compulsory failed courses MUST be registered before new courses, and they count toward the maximum |
| If carryovers exceed the max | Register carryovers first. Lower-level courses take priority over higher-level ones |
| Prerequisites | `PASSED` prerequisites must be passed. `TAKEN` ones must have been registered and sat |
| Higher-level courses | Not allowed without HOD approval |
| Fee gate | Registration submit requires `paidKobo ≥ threshold` of the session's school-fee invoice. Default threshold **100%**, or the configured first instalment |
| Window | Only inside `COURSE_REGISTRATION`. `LATE_REGISTRATION` adds the late fee item automatically |
| Approval | Level adviser approves. HOD can override |
| Elective groups | Chosen units within the group's [min, max] |
| Deferred / suspended students | Cannot register |

## 6. Level progression and duration

- Students move up one level at the start of each new session **regardless of carryovers** (default), unless on a withdrawal recommendation or in a non-active status. `[CONFIG progression.requireMinUnitsPassed]` optionally requires a minimum number of units passed.
- **Direct Entry** starts at 200 level. Credit for 100-level courses follows the tenant's DE curriculum rules.
- **Maximum duration** = normal duration × 1.5 (default, e.g. 4-year → 6 years) `[VERIFY]`. After the normal duration, the student is flagged **spillover**. Spillover fee rules apply (often reduced, per unit registered `[CONFIG]`).
- Exceeding the maximum duration → recommendation for withdrawal.

## 7. Graduation requirements

A student is eligible for a graduation list when **all** of these hold:
1. All `COMPULSORY` and `REQUIRED` curriculum items for their pinned curriculum version (or equivalents) are **passed**.
2. Elective group minimums are met.
3. Total units passed ≥ `programme.minUnitsToGraduate`.
4. Final CGPA ≥ minimum pass CGPA (default 1.00, or 1.50 if Pass degree abolished).
5. No outstanding `INC/SICK/MAL/NR` remark codes.
6. Within maximum duration, unless Senate waiver.
7. Graduation clearance case `CLEARED`.
8. No active disciplinary case with a pending sanction.

The `DegreeAudit` engine reports each rule's result with reasons, so staff can see exactly why a student isn't eligible.

## 8. Result approval workflow

- Default stages: `SUBMITTED → HOD_APPROVED → FACULTY_APPROVED → SENATE_APPROVED → PUBLISHED` `[CONFIG results.approvalStages]`.
- **Score entry** only happens while the offering's sheet is `DRAFT` or `RETURNED` and inside the `SCORE_ENTRY` window (HOD can extend it).
- **Submission locks** all entries, and a `snapshotHash` is recorded.
- **Separation of duties:** an actor who submitted a sheet can't approve it at the next stage. If the HOD is the course lecturer, the approval goes to the Dean or an acting HOD `[CONFIG]`.
- A **return** requires a comment and goes back to the lecturer.
- **Senate approval** is recorded by the Registry (Exams & Records) with the Senate meeting reference and date. It can be done in bulk per faculty/level/semester.
- **Publication** turns entries into immutable `CourseResult` rows, recomputes `SemesterResult`s, invalidates caches and emits `results.published`.
- **Provisional publication** after faculty approval is allowed if `[CONFIG results.allowProvisional]`. Results are then labelled "Provisional, subject to Senate approval".
- **Amendments after publication** need a `ResultAmendment` with reason and evidence, passing through the same stages. Both old and new values are kept and audited forever.

## 9. Admissions

| Rule | Default `[CONFIG]` |
|------|--------------------|
| UTME cut-off | Tenant/programme-level minimum (e.g. 160 national minimum for universities `[VERIFY]` per year) |
| O'level | 5 credits (C6 or better) incl. English & Mathematics plus programme-specific subjects, in ≤ 2 sittings |
| Aggregate score | Configurable weighted formula, e.g. `UTME/8 + PostUTME/2` (→ /100), or `UTME 50% + Post-UTME 30% + O'level points 20%` |
| O'level points | Configurable grade → points map (e.g. A1 = 6 … C6 = 1) |
| Quotas | Federal default: **Merit 45% / Catchment 35% / ELDS 20%** `[VERIFY]`. Private: merit only |
| Ranking | Per programme by aggregate desc. Tie-breakers: UTME score, then English score, then DOB (younger first `[CONFIG]`) |
| Second choice | Unplaced candidates may be considered for their second choice if eligible |
| Acceptance deadline | 14 days from offer (default). Lapsed offers can be reissued |
| CAPS | UniVarse **does not** admit. It produces recommendation lists for upload to CAPS and imports CAPS status back ([15](15-integrations.md)) |

Age rule: minimum age at admission (16 `[VERIFY]`) is a warning, not a hard block.

## 10. Fees and payments

- **All money is integer kobo (`bigint`).** ₦1 = 100 kobo. Never use floats. Format only at the UI edge.
- A **fee schedule** is resolved by matching the rules in order: `(session, programme | faculty | all, level, entryMode, studentCategory {FRESH, RETURNING, SPILLOVER}, residency {INDIGENE, NON_INDIGENE, INTERNATIONAL})`. The most specific match wins, and ties are a configuration error caught on approval.
- **Instalments** `[CONFIG]`: e.g. 60% / 40% with due dates. Registration gate threshold refers to them.
- **Late payment / late registration** penalties are added as separate invoice lines automatically after the deadline.
- **Payment truth:** a payment is `SUCCEEDED` only after a **server-to-server verification** with the gateway, or a **signature-verified webhook**, matching amount, currency (NGN) and reference. Redirect URLs are never trusted.
- **Idempotency:** the same gateway reference can never be applied twice (unique constraint + idempotent handler).
- **Overpayment** becomes a credit ledger entry, applied to the next invoice or refunded.
- **Waivers/scholarships** reduce via `WAIVER` ledger entries, with requester ≠ approver.
- **Refunds** need Bursar approval plus step-up auth. They're executed through the gateway where it's supported, otherwise recorded as manual with evidence.
- **Receipts** get sequential numbers per tenant (`Sequence`) and a QR verification code.
- **Reconciliation:** a daily job compares gateway settlement reports with local transactions and raises items for mismatches. Anything unresolved for 48h alerts the bursary.

## 11. Identifiers and numbering

| Identifier | Default template `[CONFIG]` | Rules |
|------------|---------------------------|-------|
| Application number | `{YYYY}{SEQ:6}` | Per cycle |
| Matric number | `{YY}/{FACULTY_CODE}/{DEPT_CODE}/{SEQ:4}` (e.g. `25/SCI/CSC/0042`) | Generated at enrolment. Sequence per `(programme or dept, cohort)`. Unique and immutable |
| Invoice number | `INV-{YYYY}-{SEQ:7}` | |
| Receipt number | `RCT-{YYYY}-{SEQ:7}` | Gap-free within tenant/year (sequence updated in the same transaction as the payment) |
| Ticket number | `TKT-{SEQ:6}` | |
| Verification code | 12-char Crockford base32, random | Unguessable. Used in QR URLs `/verify/{code}` |

## 12. Hostel allocation

| Rule | Default `[CONFIG]` |
|------|--------------------|
| Eligibility | Active, school fees threshold met, no disciplinary bar |
| Priority | Fresh students, finalists, students with disabilities, then others by first-come or lottery |
| Hold | An allocated bed is `HELD` for 72h pending hostel-fee payment, then released |
| Sex constraint | Allocation respects the hostel's sex designation |
| One bed | At most one active allocation per student per session |

## 13. Time and calendars

- All timestamps are stored in **UTC** (`timestamptz`). All deadlines are **defined and displayed in `Africa/Lagos`** (UTC+1, no DST).
- A window "closes at 23:59 on 15 March" means `2026-03-15T23:59:59+01:00`.
- Session names follow `YYYY/YYYY`, and there's only one ACTIVE session and semester per tenant.

## 14. Continuous assessment (CA tests and assignments)

| Rule | Default `[CONFIG]` |
|------|--------------------|
| CA weight | CA components sum to the scheme's CA total (default 30). Each CA test or assignment maps to **one** named component (`caComponentKey`) with its own maximum |
| Scaling | A test's raw score is scaled linearly to its component maximum: `component = raw / rawMax × componentMax`. Stored as `numeric(5,2)` with the same rounding rule as score entry (§1.2) |
| Multiple items per component | `BEST` / `AVERAGE` / `SUM_CAPPED` (default **AVERAGE**) when several tests or assignments feed one component |
| Attempts | 1 per test (default). If more are allowed, the score policy is `BEST` or `LATEST` (default **BEST**) |
| Missed CA test | Scores **0** unless the lecturer grants a make-up (audited, reason required). Medical/approved absence → make-up paper from the same bank |
| Late assignment | Window closes at `dueAt` (Africa/Lagos). Late policy: `REJECT` / `ACCEPT_WITH_PENALTY` (default penalty **10% per day, max 3 days**) / `ACCEPT` |
| Timer | Server-authoritative. Disconnection doesn't pause the clock (default). Approved accommodations add `extraTimeMin` per student |
| Release | CA scores can be released to the score sheet only while it is `DRAFT`/`RETURNED`. After submission, changes follow the result amendment path (§8) |
| Integrity findings | Never change a score automatically. The lecturer reviews the evidence, and any sanction (e.g. invalidating an attempt) needs a reason, is audited, and can be escalated to a malpractice case |
| Student visibility | Students see their own CA scores once released `[CONFIG]` (default: immediately for objective tests, after manual marking otherwise). Answer keys are shown only if the lecturer enables review after the window closes |

## 15. Sessions, carryovers and spillovers (summary)

Already defined in §5–§6. The operational expectation (from [01 §1](01-product-brief.md)) is that **session rollover is a guided, previewable, idempotent operation** ([05 §5](05-modules-and-features.md)). It:
- promotes levels,
- carries forward outstanding courses as carryovers,
- flags spillover students against their maximum duration,
- opens the new session's windows,

all with a dry-run report before commit, and all audited.
