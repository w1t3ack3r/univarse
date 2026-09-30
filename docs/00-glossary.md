# 00 — Glossary

Shared vocabulary for code, UI and docs. **Use these exact terms in code identifiers** (in their English form, e.g. `carryover`, `matricNumber`, `senateList`).

## Nigerian higher-education terms

| Term | Meaning | Code identifier |
|------|---------|-----------------|
| **NUC** | National Universities Commission. Regulates universities, sets minimum academic standards | — |
| **CCMAS** | Core Curriculum and Minimum Academic Standards. NUC's curriculum baseline (2023 edition onward) | — |
| **NBTE / NCCE** | Regulators for polytechnics / colleges of education (future tenant types) | `tenantType` |
| **JAMB** | Joint Admissions and Matriculation Board. Runs UTME and controls admissions via CAPS | — |
| **UTME** | Unified Tertiary Matriculation Examination. JAMB entrance exam, scored out of 400 | `utmeScore` |
| **DE** | Direct Entry. Admission into 200 level using A-level/ND/NCE etc. | `entryMode = DIRECT_ENTRY` |
| **Post-UTME** | The institution's own screening (test and/or document screening) after UTME | `screening` |
| **CAPS** | JAMB Central Admissions Processing System. Institutions recommend candidates and candidates accept offers there | — |
| **O'level** | Secondary-school certificate results (WAEC SSCE, NECO SSCE, NABTEB). Admission typically needs 5 credits incl. English & Maths, in ≤2 sittings | `olevelResult` |
| **Catchment / ELDS** | Admission quota categories: catchment area states; Educationally Less Developed States | `admissionQuota` |
| **Matric number** | Permanent student identifier issued by the institution | `matricNumber` |
| **Matriculation** | Formal admission ceremony/status. Student record becomes fully active | — |
| **Session** | Academic year, e.g. `2025/2026` | `AcademicSession` |
| **Semester** | Half of a session: First (Harmattan/Rain naming varies) and Second | `Semester` |
| **Level** | Year of study expressed as 100, 200 … 600 | `level` |
| **Credit unit (CU)** | Course weight used in GPA calculation | `creditUnits` |
| **GP** | Grade point, e.g. A = 5 | `gradePoint` |
| **GPA / CGPA** | Semester / cumulative grade point average on a 5.0 scale | `gpa`, `cgpa` |
| **TCU / TCP / TGP** | Total credit units / total credit points / total grade points (TCP = Σ CU × GP) | `tcu`, `tcp` |
| **Carryover** | A failed compulsory course that must be re-registered in a later session | `attemptType = CARRYOVER` |
| **Spillover** | A student who has exceeded the normal programme duration but is still within the maximum | `isSpillover` |
| **Probation** | Academic warning status when CGPA falls below threshold | `academicStanding = PROBATION` |
| **Withdrawal (academic)** | Required to leave the programme for poor performance | `studentStatus = WITHDRAWN` |
| **Rustication** | Disciplinary suspension for a fixed period | `studentStatus = RUSTICATED` |
| **Expulsion** | Permanent disciplinary removal | `studentStatus = EXPELLED` |
| **Deferment** | Approved break in studies (a session) | `studentStatus = DEFERRED` |
| **HOD** | Head of Department | role `HOD` |
| **Dean / Provost** | Head of a Faculty / College | role `DEAN` |
| **Level adviser / Course adviser** | Lecturer who advises and approves course registration for a level/cohort | role `LEVEL_ADVISER` |
| **Exams & Records** | Registry unit that manages results, transcripts and certificates | role `EXAMS_RECORDS_OFFICER` |
| **Registrar** | Chief administrative officer, secretary to Senate | role `REGISTRAR` |
| **Bursary / Bursar** | Finance unit / its head | role `BURSARY_OFFICER`, `BURSAR` |
| **Senate** | Supreme academic body. Approves results and graduation lists | — |
| **Departmental / Faculty Board** | Committees that consider results before Senate | workflow stages |
| **Broadsheet** | Wide spreadsheet of all students × courses × scores/grades for a class, used at board meetings | `broadsheet` |
| **Mastersheet** | Consolidated result summary per student across semesters | `mastersheet` |
| **Senate list** | List of graduating students with class of degree, approved by Senate | `GraduationList` |
| **Class of degree** | First Class, Second Class Upper (2:1), Second Class Lower (2:2), Third Class, Pass | `degreeClass` |
| **Clearance** | Multi-unit sign-off (library, bursary, hostel, department…) before graduation or other events | `ClearanceCase` |
| **Transcript** | Official academic record, sent to a destination or given to the student | `Transcript` |
| **NYSC** | National Youth Service Corps. Graduates are mobilised from institution-submitted lists | `nyscList` |
| **Exam docket / exam card** | Proof of eligibility to sit exams | `examDocket` |
| **School fees / acceptance fee** | Tuition-type charges / one-time fee to accept an admission offer | `FeeItem` |
| **TSA** | Treasury Single Account. Federal institutions collect revenue through it, usually via Remita | — |
| **RRR** | Remita Retrieval Reference. The payment reference a payer uses on Remita | `gatewayReference` |
| **Indigene / non-indigene** | State-of-origin distinction. Some state institutions charge different fees | `feeCategory` |
| **NIN** | National Identification Number (NIMC) | `nin` (encrypted) |
| **NDPA / NDPC** | Nigeria Data Protection Act 2023 / the Commission that enforces it | — |

## Platform terms

| Term | Meaning |
|------|---------|
| **Tenant** | One institution on the platform. Everything tenant-owned carries `tenant_id` |
| **Platform / control plane** | Cross-tenant layer: tenant registry, provisioning, billing, platform staff. Lives in the `platform` database |
| **Pool / pooled tenant** | Tenant whose data lives in a shared tenant database, isolated by RLS |
| **Silo / dedicated tenant** | Tenant with its own database (same schema). Premium/regulatory tier |
| **Shard** | A tenant database (a pool DB or a silo DB), registered in the platform DB |
| **Platform staff** | UniVarse employees (Super Admin, Support, Finance). Never share identity with tenant users |
| **Workspace** | The permission-driven staff UI at `/staff` |
| **Scope** | The org boundary a role applies to: institution, faculty, department, programme, course offering, hostel |
| **Step-up** | Re-authentication (password + MFA) needed before a sensitive action |
| **Outbox** | Table where domain events are written in the same transaction as the change, then published asynchronously |
