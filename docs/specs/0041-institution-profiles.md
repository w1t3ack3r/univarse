# Spec 0041: Phase 2's P2-S0, the institution-type profiles

**Status:** Draft, for the owner's approval: Q1 to Q11 and the profiles' contents (the appendix), with their `[VERIFY]` marks.
**Phase:** 2, slice **P2-S0** of [spec 0040](0040-phase-2-institution-setup.md) ("Phase start").
**Builds on:**

- [spec 0040](0040-phase-2-institution-setup.md) (approved 2026-11-26): Q1 (three institution types on one core), Q2 (configurable unit types), Q5 (approval chain defaults by type), Q7 (the staff model), Q8 (colleges of education and the dual mandate), Q9 (`[VERIFY]` reference data), Q10 (profiles as data);
- [ADR-039](../19-decision-log.md): "One academic core; institution types are profiles of data" (accepted 2026-11-26);
- [spec 0034](0034-provisioning.md) Q6 and Q-A4: templates as versioned data in `packages/domain`, applied by provisioning's `template` step, a setting written only where the institution has none;
- [spec 0038](0038-offboarding-and-purge.md): every tenant table is classified for the export and deleted by the purge;
- **the owner's Phase 2 guidance documents (2026-11-26), kept locally:** the university and polytechnic drafts (§1 org tree, §2 qualifications, §3 approval, §4 calendar, the polytechnic draft's §7 governance and ranks) and the three structural baselines (governance bodies, offices, staff categories and cadres, employment types and status, academic ranks, the NCCE 2026 dual mandate);
- invariant 4: **institution differences are settings, never `if (tenant === …)`**.

T40 to T45 and ADR-039 itself went in with spec 0040 (#201). What's left for P2-S0 is the profiles themselves.

## Why

Every later slice of Phase 2 starts an institution with something:
- S1 with its unit types and their names ("School" or "Faculty");
- S3 with its staff categories, cadres, ranks, offices and governance bodies;
- S4 with its qualifications and their level labels;
- S5 with its approval chain;
- S6 with its period and window types.

Spec 0040 Q10 puts all of that in one place per institution type, as data, copied into the institution when it is provisioned. The institution then owns its copy.

If each slice invented its own defaults, the three types would drift, and a polytechnic would get a university's words wherever a slice forgot. If the defaults lived in code that branches on the type, invariant 4 would be broken on the first day of the first domain phase. P2-S0 writes the profiles once, checks them, and gives every institution its copy before any slice needs it.

## What exists today

- **`packages/domain/src/platform/provisioning.ts` holds three templates,** `university@1`, `polytechnic@1` and `college-of-education@1`. They are identical: one setting, `registration.unitLimits`. `templateForType` proposes one from the institution's type.
- **Provisioning's `template` step** writes a template's settings into the institution, each only if it has no row yet (Q-A4), audited as `settings.template_applied`.
- **`tenant.template`** (platform) records the template an institution was provisioned from, as `polytechnic@1`. It is null for the seed's tenants and the drill's.
- **The tenant database has no record of its type.** Only the platform knows it (`tenant.type`, `tenant.regulator`).
- **`org_unit` has a fixed `type` enum** (`INSTITUTION` … `UNIT`); S1 replaces it with configurable unit types.
- **No code compares the institution type to a literal** outside the platform's registry and templates (checked: none in `apps/` or `packages/`).

## Decisions for approval

| # | Decision | Recommendation, and why |
| --- | --- | --- |
| Q1 | **A profile is the template's new content.** The templates become `university@2`, `polytechnic@2` and `college-of-education@2`: the same setting as `@1`, plus a `profile`. There is one version per template. | Spec 0040 Q10 says the templates "grow from settings into profiles". A separate profile version beside the template's would give two numbers for one decision. A job created under `@1` and resumed after the release applies `@2`; its audit records the version it applied. |
| Q2 | **What a profile holds** (the appendix has each type's contents):<ul><li>unit types, each with its kind (`ACADEMIC`, `ADMINISTRATIVE` or `RESEARCH`) and the institution's own name for it;</li><li>qualifications, each with its family, its level labels and whether it's offered by default;</li><li>staff categories, cadres with their ranks in order, employment types and employment statuses;</li><li>offices, each with its scope (the institution, a unit or a programme);</li><li>governance bodies, each with its kind and scope;</li><li>the curriculum approval chain's default stages;</li><li>period types, with the default semesters;</li><li>window types;</li><li>the regulators.</li></ul> | Spec 0040 Q10's list, and nothing a slice doesn't need. Roles aren't in a profile: which role an office grants is S3's decision, against the permission catalogue. |
| Q3 | **Keys are the same across the three types; the names are each type's own.** `HOD` is `HOD` everywhere. The head of the institution is the office `HEAD_OF_INSTITUTION`: "Vice-Chancellor" in a university, "Rector" in a polytechnic, "Provost" in a college of education. **The central academic body is the exception:** `SENATE` and `ACADEMIC_BOARD` are different keys. | One key lets an approval chain, a scope or a report mean the same thing at every institution, and the words stay the institution's. The guidance documents are explicit that a Senate and an Academic Board are "not interchangeable legal bodies", so one key would hide a real difference. |
| Q4 | **An institution's copy is a snapshot row, `institution_profile`, in its own database:** the template, its version, the profile as `jsonb`, and when it was applied. **The row is append-only.** <br><br>Each later slice **materialises its part** of the snapshot into its own editable tables, and the institution's edits live there, never in the snapshot. For example, S1 makes the unit-type rows from it, and S3 the ranks. **A slice's migration can do this for institutions already live, in SQL inside the same database**, because the snapshot is a tenant row. | The snapshot records what an institution started with, for audits and for "reset to the default". Keeping it in the tenant's own database is what lets S1 to S6 seed institutions provisioned before them without reading the platform: a tenant migration can't. Append-only because a starting point that can be rewritten isn't one. |
| Q5 | **Who applies it:**<ul><li>**provisioning's `template` step,** in the same tenant transaction as the settings, audited as `setup.profile_applied` (template and version, never content);</li><li>**the seed,** for its tenants, through the same function;</li><li>**a worker pass, `ProfilePass`,** for institutions already live with no profile yet. It covers `ONBOARDING`, `ACTIVE` and `SUSPENDED`, on a servable shard. It runs at start and then every 15 minutes, and finds them by a platform column (Q6).</li></ul>`OFFBOARDING`, `ARCHIVED` and `PURGED` institutions are never given one; their configuration is frozen. The institution's profile comes from `tenant.template` if it has one, otherwise from its type's template. | One function, three callers, as with `seedTenantBase`. The worker reaches every shard through `ShardRegistry`; the migrate job's seed knows only the first pool. A `REQUESTED` or `PROVISIONING` institution gets it from its job. |
| Q6 | **The platform records which profile an institution got:** `tenant.profile` (`polytechnic@2`) and `tenant.profile_applied_at`, set after the tenant's row commits. Only the worker writes them. | The worker pass selects `profile IS NULL`, one cheap query once every institution has one, instead of reading every tenant database every 15 minutes. The console can show the fact without tenant credentials (spec 0025 A2). If the worker stops between the two writes, the next pass finds the tenant row there and only sets the column. |
| Q7 | **A newer profile is never applied to an existing institution automatically.** A new version (`@3`) is for new institutions. Changing institutions already live is that slice's own spec, and it only adds what's missing, never overwriting an institution's own edits. | "The institution then owns and edits its copy" (spec 0040 Q10). This is the same rule as Q-A4's settings. |
| Q8 | **The console shows it:** the institution's facts gain "Profile", for example "Polytechnic, version 2, applied 26 November 2026", or "Not applied yet". There is no tenant route or screen in P2-S0. | The console is where the owner checks acceptance 3 ("all three types provision from their profiles") on the stack. Inside an institution, each part appears in its own slice's screen (S1's unit types, S3's ranks…). A read-only page now would be replaced by those screens. |
| Q9 | **Qualifications are offered by default only where the type normally awards them:**<ul><li>a university: its bachelor's, postgraduate diploma, master's and doctorate families;</li><li>a polytechnic: ND and HND, with NID, certificates and professional diplomas off;</li><li>a college of education: NCE, with its degree families (B.Ed., B.A.(Ed.), B.Sc.(Ed.)), PGDE and NSQ off until the institution confirms its approvals.</li></ul> | The guidance documents say "never every qualification for every institution", and that a college's degree programmes need NCCE and NUC approval. S4 lets each institution switch them on. |
| Q10 | **ADR-039 is enforced by lint:** an ESLint rule rejects a comparison or a `switch` case on `'UNIVERSITY'`, `'POLYTECHNIC'` or `'COLLEGE_OF_EDUCATION'` in source files, outside the platform's registry and templates (`packages/domain/src/platform/`) and tests. | Invariant 4 has been a review rule; Phase 2 is where it would first be broken, and a lint failure catches it before review does. |
| Q11 | **The checks on the data are pure tests** in `packages/domain`: every key is unique in its list; every approval stage names an office or a body in the same profile; every cadre's category exists; every qualification has level labels; every offered qualification's family is in the profile; the profiles are frozen. A test also pins the differences the documents require, such as a polytechnic's `ACADEMIC_BOARD` in its chain and a college's NCE beside its degree families. | Wrong data in a profile is copied into every institution of that type and then owned by each of them, so it has to be right before anything is copied. |

## Threats

No new rows. The snapshot's integrity is T40's concern in spirit, a starting point changed afterwards: the row is append-only for the app's role (`UPDATE` and `DELETE` revoked), and only the purge, as the migrator, deletes it. A profile holds no personal data and no secret.

## Acceptance criteria

1. **The three profiles** pass Q11's checks, and their differences match the guidance documents (the appendix).
2. **A provisioned institution of each type** has its `institution_profile` row, `tenant.profile` and the audit `setup.profile_applied`. A resumed or repeated step changes nothing.
3. **An institution live before the release** (the seed's, the drill's, the stack's) gets its profile from `ProfilePass`. An `OFFBOARDING`, `ARCHIVED` or `PURGED` one doesn't.
4. **The row is append-only** for the app's role, is visible only inside its own tenant (a cross-tenant test), is in the institution's export, and is deleted by the purge. `pnpm rls:check` passes.
5. **The lint rule** fails on a comparison with a type literal (a fixture) and passes the codebase.
6. **The console** shows each institution's profile, or "Not applied yet".
7. Released, deployed and checked on the stack by the owner: every institution on the stack shows a profile in the console.

## The PR

One PR. It contains:
- the domain's profiles and checks;
- the tenant migration (`institution_profile`, forced RLS, its grants);
- the platform migration (`tenant.profile`, `tenant.profile_applied_at`, the worker's column grant);
- the shared `applyInstitutionProfile`, called from provisioning's step and the seed;
- `ProfilePass`;
- the export catalogue's entry and the purge's table order;
- the lint rule;
- the console's fact, the contract and `contracts:gen`;
- the tests and the docs.

## The owner's steps

- Approve or change Q1 to Q11 and the appendix. The ranks, governance bodies and approval defaults are `[VERIFY]`: they are what the documents describe, and each institution checks them against its own Scheme of Service and enabling law in S3 and S5.
- After the release and deploy: check the console's Institutions shows a profile for each institution on the stack.

## Affected docs

- [03](../03-domain-model.md) §3: `InstitutionProfile` becomes the snapshot, and the platform's `Tenant` gains `profile`.
- [07](../07-data-and-database.md): the new table, append-only, and its grants.
- [05](../05-modules-and-features.md) §1: provisioning applies the profile.
- [spec 0034](0034-provisioning.md): a note that the templates are `@2` from P2-S0.
- [17](../17-coding-standards.md): the lint rule.
- [19](../19-decision-log.md): ADR-039's enforcement.
- [18](../18-roadmap.md): P2-S0's progress.

## Out of scope

- **The editable tables:** unit types (S1); staff catalogues, offices and bodies (S3); qualifications (S4); the approval chain (S5); periods and windows (S6). Each materialises its part of the snapshot.
- **Changing an institution's profile, or "reset to the default"**: the slice that owns the part.
- **Upgrading live institutions to a newer profile version** (Q7).
- **A tenant screen for the profile** (Q8).
- **Which role each office grants** (S3).

## Appendix: the profiles' contents

The entries are drawn from the owner's guidance documents. Words in quotes are each type's names; keys are in `CODE`. Entries marked `[VERIFY]` depend on the institution's Scheme of Service, conditions of service or enabling law.

### Unit types

| Key | Kind | University | Polytechnic | College of education |
| --- | --- | --- | --- | --- |
| `COLLEGE` | Academic | "College" | — | — |
| `FACULTY` | Academic | "Faculty" | "Faculty" | — |
| `SCHOOL` | Academic | "School" | "School" | "School" |
| `DEPARTMENT` | Academic | "Department" | "Department" | "Department" |
| `ACADEMIC_UNIT` | Academic | "Academic Unit" | "Academic Unit" | "Academic Unit" |
| `INSTITUTE` | Research | "Institute" | — | — |
| `CENTRE` | Research | "Centre" | "Centre" | "Centre" |
| `DIRECTORATE` | Administrative | "Directorate" | "Directorate" | "Directorate" |
| `ADMINISTRATIVE_DEPARTMENT` | Administrative | "Administrative Department" | "Administrative Department" | "Administrative Department" |
| `DIVISION` | Administrative | "Division" | "Division" | "Division" |
| `UNIT` | Administrative | "Unit" | "Unit" | "Unit" |
| `SECTION` | Administrative | "Section" | "Section" | "Section" |

The root stays the institution itself (today's `INSTITUTION`), as provisioning creates it. Any type may contain any other (spec 0040 Q2); S1 holds the tree's rules.

### Qualifications and level labels

| Type | Offered by default | Off by default |
| --- | --- | --- |
| University | B.Sc., B.A., B.Eng., B.Tech., LL.B., MBBS (bachelor's: "100 Level" to "600 Level"); PGD; M.Sc., M.A., MBA, M.Phil. (master's); Ph.D. (doctorate). Postgraduate levels "Year 1", "Year 2" … | — |
| Polytechnic | ND ("ND1", "ND2"), HND ("HND1", "HND2") | NID ("NID1", "NID2") `[VERIFY]`, Certificate, Professional Diploma |
| College of education | NCE ("NCE 100 Level", "NCE 200 Level", "NCE 300 Level") | B.Ed., B.A.(Ed.), B.Sc.(Ed.) ("100 Level" to "400 Level"); PGDE; NSQ |

A qualification's **family** (`BACHELOR`, `POSTGRADUATE_DIPLOMA`, `MASTER`, `DOCTORATE`, `ND`, `HND`, `NID`, `CERTIFICATE`, `PROFESSIONAL_DIPLOMA`, `NCE`, `PGDE`, `NSQ`) is what later rules are chosen by (spec 0040 Q10), never the institution's type. A programme of N years uses the first N labels; part-time arrangements are S4's.

### Staff

- **Categories (all three types):** Academic, Research, Library, Administrative, Finance, Technical, Professional, Medical, ICT, Clerical, Secretarial, Operational, Security.
- **Employment types (all three types):** Permanent/Pensionable, Contract, Temporary, Casual, Part-time, Adjunct, Visiting, Sabbatical, Secondment, Postdoctoral, NYSC, Outsourced. The university baseline also lists Graduate Assistant as an employment type; here it is only a rank, so the same thing isn't recorded twice.
- **Employment statuses (all three types):** Active, On Probation, Confirmed, On Leave, On Study Leave, On Sabbatical, On Secondment, On Suspension, On Maternity/Paternity Leave, On Medical Leave, On Retirement, Retired, Resigned, Terminated, Deceased.
- **The academic cadre's ranks, in order** `[VERIFY]`:
  - **university:** Graduate Assistant, Assistant Lecturer, Lecturer II, Lecturer I, Senior Lecturer, Associate Professor (also called Reader: one rank with two titles, not two ranks), Professor;
  - **polytechnic:** Assistant Lecturer, Lecturer III, Lecturer II, Lecturer I, Senior Lecturer, Principal Lecturer, Chief Lecturer;
  - **college of education:** the polytechnic's ladder. For a dual-mandate college, Principal Lecturer may also be titled Associate Professor, and Chief Lecturer Professor.
- **The administrative cadre's ranks** `[VERIFY]` (all three types, the documents' illustrative ladder): Clerical Officer, Senior Clerical Officer, Assistant Executive Officer, Executive Officer, Higher Executive Officer, Administrative Officer II, Administrative Officer I, Principal Administrative Officer, Assistant Registrar, Principal Assistant Registrar, Senior Assistant Registrar, Deputy Registrar. Registrar is an office, not a rank.
- **The secretarial cadre's ranks** `[VERIFY]`: Confidential Secretary III, II and I, Senior, Principal and Chief Confidential Secretary.
- **Other cadres, named without ranks** (each institution adds its ladder in S3): Research Officer, Librarian, Library Officer, Accountant, Auditor, Technologist, Technician, Engineer, ICT Professional, Legal Officer, Procurement Officer, Medical Officer, Nursing.

### Offices

| Key | Scope | University | Polytechnic | College of education |
| --- | --- | --- | --- | --- |
| `HEAD_OF_INSTITUTION` | Institution | "Vice-Chancellor" | "Rector" | "Provost" |
| `DEPUTY_HEAD_OF_INSTITUTION` | Institution | "Deputy Vice-Chancellor" | "Deputy Rector" | "Deputy Provost" |
| `REGISTRAR` | Institution | "Registrar" | "Registrar" | "Registrar" |
| `BURSAR` | Institution | "Bursar" | "Bursar" | "Bursar" |
| `LIBRARIAN` | Institution | "University Librarian" | "Polytechnic Librarian" | "College Librarian" |
| `PROVOST` | Unit | "Provost" (of a college) | — | — |
| `DEAN` | Unit | "Dean" | "Dean" | "Dean" |
| `DEPUTY_DEAN` | Unit | "Deputy Dean" | "Deputy Dean" | "Deputy Dean" |
| `HOD` | Unit | "Head of Department" | "Head of Department" | "Head of Department" |
| `DEPUTY_HOD` | Unit | "Deputy Head of Department" | — | — |
| `DIRECTOR` | Unit | "Director" | "Director" | "Director" |
| `EXAMINATION_OFFICER` | Unit | "Examination Officer" | "Examination Officer" | "Examination Officer" |
| `PROGRAMME_COORDINATOR` | Programme | "Programme Coordinator" | "Programme Coordinator" | "Programme Coordinator" |
| `LEVEL_COORDINATOR` | Programme | "Level Coordinator" | "Level Coordinator" | "Level Coordinator" |
| `COURSE_ADVISER` | Programme | "Course Adviser" | "Course Adviser" | "Course Adviser" |
| `SIWES_COORDINATOR` | Unit | "SIWES Coordinator" | "SIWES Coordinator" | "SIWES Coordinator" |
| `TEACHING_PRACTICE_COORDINATOR` | Unit | — | — | "Teaching Practice Coordinator" |

### Governance bodies `[VERIFY]`

| Key | Kind | Scope | University | Polytechnic | College of education |
| --- | --- | --- | --- | --- | --- |
| `GOVERNING_COUNCIL` | Governing | Institution | "Governing Council" | "Governing Council" | "Governing Council" |
| `SENATE` | Academic | Institution | "Senate" | — | — |
| `ACADEMIC_BOARD` | Academic | Institution | — | "Academic Board" | "Academic Board" |
| `MANAGEMENT_COMMITTEE` | Management | Institution | "University Management Committee" | "Management Committee" | "College Management Committee" |
| `CONGREGATION` | Assembly | Institution | "Congregation" | — | "Congregation" |
| `CONVOCATION` | Assembly | Institution | "Convocation" | — | "Convocation" |
| `ACADEMIC_STAFF_CONGREGATION` | Assembly | Institution | — | — | "Academic Staff Congregation" |
| `UNIT_BOARD` | Academic | Unit | "Faculty Board" | "School Board" | "School Board" |

### The curriculum approval chain, by default (spec 0040 Q5)

- **University:** `HOD` → `DEAN` → `SENATE`, with the Senate stage off until the institution switches it on.
- **Polytechnic and college of education:** `HOD` → `DEAN` → `ACADEMIC_BOARD`.

External approval (NUC, NBTE, NCCE) is never a stage. S5 records it as its own event.

### Periods and windows

- **Period types:**
  - **all three types:** `SEMESTER` ("First Semester", "Second Semester");
  - **university:** `SUMMER`, and `SIWES` where a programme has it;
  - **polytechnic:** `SIWES` and `INDUSTRIAL_ATTACHMENT`;
  - **college of education:** `TEACHING_PRACTICE`, and `SIWES` where a programme has it.
- **Window types:**
  - **all three types:** `APPLICATION`, `COURSE_REGISTRATION`, `LATE_REGISTRATION`, `ADD_DROP`, `FEE_PAYMENT`, `SCORE_ENTRY`, `EXAMINATION`, `HOSTEL_APPLICATION`, `CLEARANCE`, `GRADUATION_PROCESSING`;
  - **polytechnic:** also `SIWES_APPLICATION`, `SIWES_ASSESSMENT` and `PROJECT_SUBMISSION`;
  - **university and college of education:** also `PROJECT_SUBMISSION`.

### Regulators

- **University:** NUC.
- **Polytechnic:** NBTE.
- **College of education:** NCCE, and NUC for its degree programmes.
