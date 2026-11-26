# Spec 0041: Phase 2's P2-S0, the institution-type profiles

**Status:** **Done (2026-11-26).** Released as `e94e732` and deployed; criterion 7 passed on the stack (see "Done" below). **The build's decisions Q-A1 to Q-A10 approved by the owner on 2026-11-26.** **Approved by the owner on 2026-11-26, with refinements, all written in below:**
- **Q2:** unit-type hierarchy rules, award types, academic and administrative governance kept apart, mandatory and conditional approval stages, and the regulators of each qualification.
- **Q3:** stable lower-case keys, such as `institution_head`, `department_head` and `academic_governing_body`.
- **Q6:** an assignment record with the content hash, the source and the status.
- **Q7:** an upgrade is an explicit, versioned migration with its compatibility and rollback.
- **Q8:** the console shows the assignment's status.
- **Q9:** the university's other award types; defaults are never claims of approval.
- **Q10:** the lint rule's permitted places.
- **Q11:** the full list of checks.
- **The principle that institution-type differences stay data-driven.**

**Phase:** 2, slice **P2-S0** of [spec 0040](0040-phase-2-institution-setup.md) ("Phase start").
**Builds on:**

- [spec 0040](0040-phase-2-institution-setup.md) (approved 2026-11-26): Q1 (three institution types on one core), Q2 (configurable unit types; refined here, Q2), Q5 (approval chain defaults by type), Q7 (the staff model), Q8 (colleges of education and the dual mandate), Q9 (`[VERIFY]` reference data), Q10 (profiles as data);
- [ADR-039](../19-decision-log.md): "One academic core; institution types are profiles of data" (accepted 2026-11-26);
- [spec 0034](0034-provisioning.md) Q6 and Q-A4: templates as versioned data in `packages/domain`, applied by provisioning's `template` step, a setting written only where the institution has none;
- [spec 0038](0038-offboarding-and-purge.md): every tenant table is classified for the export and deleted by the purge;
- **the owner's Phase 2 guidance documents (2026-11-26), kept locally:**
  - the university and polytechnic drafts: §1 (org tree), §2 (qualifications), §3 (approval), §4 (calendar), and the polytechnic draft's §7 (governance and ranks);
  - the three structural baselines: governance bodies, offices, staff categories and cadres, employment types and statuses, academic ranks, and the NCCE 2026 dual mandate;
- invariant 4: **institution differences are settings, never `if (tenant === …)`**.

T40 to T45 and ADR-039 itself went in with spec 0040 (#201). What's left for P2-S0 is the profiles themselves.

## The principle (the owner, 2026-11-26)

**Institution-type differences are data-driven.** The shared academic core doesn't gather university, polytechnic or college branches as the slices arrive. What differs is expressed through:
- profile data;
- configurable policies;
- explicit adapters, only where one is genuinely necessary.

A rule that differs is chosen by a stable identifier in the data, such as a qualification's family, never by the institution's type.

## Why

Every later slice of Phase 2 starts an institution with something:
- S1 with its unit types, their names ("School" or "Faculty") and which may contain which;
- S3 with its staff categories, cadres, ranks, offices and governance bodies;
- S4 with its qualifications, award types and level labels;
- S5 with its approval chains;
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

## Decisions (approved)

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **A profile is the template's new content.** The templates become `university@2`, `polytechnic@2` and `college-of-education@2`: the same setting as `@1`, plus the institution-type profile. There is one version per template. | Spec 0040 Q10 says the templates "grow from settings into profiles". A separate profile version beside the template's would give two numbers for one decision. A job created under `@1` and resumed after the release applies `@2`; its assignment records the version it applied (Q6). |
| Q2 | **A profile is structured, versioned data**, and it holds (the appendix has each type's contents):<ul><li>**unit types and their hierarchy rules:** each type's kind (academic, administrative or research), its name, and the types it may contain;</li><li>**qualifications, award types and level labels:** each qualification's family, its award type (degree, diploma or certificate), its level labels, its regulators, and whether it's offered by default;</li><li>**the default academic structure:** the semesters a session holds, and each qualification's level labels;</li><li>**staff:** categories, cadres with their ranks in order, employment types and employment statuses;</li><li>**institutional offices**, each with its scope (the institution, a unit or a programme);</li><li>**governance bodies**, each with its kind (academic, administrative or an assembly), its scope, and the function it holds, so academic and administrative governance are never mixed;</li><li>**the default approval chains**, starting with the curriculum's, each stage mandatory or conditional;</li><li>**period types and calendar window types;**</li><li>**regulators**, and which qualification each one regulates.</li></ul> | Spec 0040 Q10's list, with the owner's additions. **Spec 0040 Q2 is refined:** an institution's tree follows its unit types' hierarchy rules, seeded from the profile and editable in S1, instead of "any type may contain any other". Roles aren't in a profile: which role an office grants is S3's decision, against the permission catalogue. |
| Q3 | **Stable, machine-readable keys in lower-case `snake_case`, with each type's own display names.**<ul><li>`institution_head`: "Vice-Chancellor", "Rector" or "Provost".</li><li>`department_head`: "Head of Department".</li><li>`academic_governing_body`: a **function**, held by the body `senate` in a university and by `academic_board` in a polytechnic or college of education.</li></ul>**Senate and Academic Board stay distinct identities, with different keys.** What's shared is the function they hold. | One key lets an approval chain, a scope or a report mean the same thing at every institution, while the words stay the institution's. A chain that names `academic_governing_body` works at all three types and still records which body decided. Similar responsibilities don't make two legal bodies interchangeable. |
| Q4 | **Two distinct things:**<ol><li>**the assigned profile snapshot.** One row per assignment, `institution_profile`, in the institution's own database: the template, its version, its content hash, the profile as `jsonb`, and when and how it was assigned. **Append-only; never modified;**</li><li>**the institution's editable configuration tables,** which each later slice fills from the snapshot. S1 makes the unit types from it, S3 the ranks, and so on.</li></ol>**Each slice owns the projection of its part.** Its migration projects that part for institutions already live, in SQL inside the same database. Its code projects it for new ones. There is no second representation of a profile. Nothing later overwrites an institution's customisation. | The snapshot records exactly what an institution started with, for audits and for a later "reset to the default". Because it is a tenant row, S1 to S6 can project it for institutions provisioned before them without reading the platform, which a tenant migration can't do. |
| Q5 | **Who assigns it.** One function, `assignInstitutionProfile`, has three callers:<ul><li>**provisioning's `template` step,** for new institutions, in the same tenant transaction as the settings;</li><li>**the seed,** for the demo institutions;</li><li>**a worker pass, `ProfilePass`,** for institutions already live with no profile yet. It is idempotent and covers `ONBOARDING`, `ACTIVE` and `SUSPENDED` on a servable shard. It runs at start and then every 15 minutes.</li></ul>`OFFBOARDING`, `ARCHIVED` and `PURGED` institutions never receive one, and nothing of theirs is modified. An institution's profile comes from `tenant.template` if it has one, otherwise from its type's template. **Running it again creates no second assignment and changes no configuration.** The snapshot is unique per institution, template and version. A settings row already there stays as it is (Q-A4). Every assignment is audited as `setup.profile_assigned`, with the template, the version and the hash, never the content. | One function with three callers, as with `seedTenantBase`. The worker reaches every shard through `ShardRegistry`; the migrate job's seed knows only the first pool. A `REQUESTED` or `PROVISIONING` institution gets its profile from its job. |
| Q6 | **The platform records every assignment** in a table, `tenant_profile_assignment`, with one row per institution and version:<ul><li>the profile (`polytechnic`) and its version;</li><li>the content hash;</li><li>the source (`PROVISIONING`, `SEED` or `BACKFILL`);</li><li>the status: `PENDING`, then `ASSIGNED`, or `FAILED` with a fixed error code;</li><li>when it was assigned.</li></ul>The worker writes it; the seed writes its own institutions'. A row is `ASSIGNED` only after the tenant's snapshot commits. | This gives a reliable trail of exactly which profile an institution received. The pass finds institutions with no `ASSIGNED` row in one cheap query, instead of reading every tenant database every 15 minutes. The console can show it without tenant credentials (spec 0025 A2). If the worker stops between the two writes, the next pass finds the snapshot there, with the same hash, and only marks the row. The content hash is SHA-256 of the profile's canonical JSON; the snapshot and the platform row hold the same one. |
| Q7 | **A new profile version never modifies a live institution automatically.** A new version (`@3`) is for new institutions. **An upgrade of institutions already live is an explicit, versioned and audited migration,** in its own spec, which states:<ul><li>its compatibility with each earlier version;</li><li>what it adds, and it only adds what's missing, never overwriting an institution's edits;</li><li>how it is rolled back.</li></ul>It appends a new snapshot and a new assignment; it never edits the old ones. | "The institution then owns and edits its copy" (spec 0040 Q10), and the same rule as Q-A4's settings. |
| Q8 | **The console's institution page shows the assignment:** the profile, its version, its status and when it was assigned. For example: "Polytechnic, version 2: assigned 26 November 2026", or "Pending", or "Failed: shard unavailable". It is an administrative inspection view, not a configuration screen. There is no tenant route or screen in P2-S0. | The console is where the owner checks acceptance 3 ("all three types provision from their profiles") on the stack. Inside an institution, each part appears in its own slice's screen (S1's unit types, S3's ranks…). |
| Q9 | **Default qualifications** (initial configuration only):<ul><li>**a university:** bachelor's, postgraduate diploma, master's and doctorate offered; its other award types (diplomas and certificates) present but off;</li><li>**a polytechnic:** ND and HND offered; NID, certificates and professional diplomas off;</li><li>**a college of education:** NCE offered; its degree programmes (B.Ed., B.A.(Ed.), B.Sc.(Ed.)), PGDE and NSQ off until the institution confirms the relevant NCCE and NUC approvals.</li></ul>**A default is never a claim that a programme has regulatory approval or accreditation.** Approved programmes and their accreditation records are configured separately (S4). | The guidance documents say "never every qualification for every institution", and that a college's degree programmes need NCCE and NUC approval. |
| Q10 | **ADR-039 is enforced by lint.** An ESLint rule rejects a comparison, or a `switch` case, on `'UNIVERSITY'`, `'POLYTECHNIC'` or `'COLLEGE_OF_EDUCATION'` in application and domain logic. Logic consumes profile data, capabilities and stable identifiers. **It is permitted in:**<ul><li>the profile definitions and provisioning's profile selection (`packages/domain/src/platform/`);</li><li>tests (`*.spec.ts`);</li><li>explicit migration tooling (`packages/db-ops`).</li></ul>Each of these is listed by path in the rule, so a new exception is a reviewed change. | Invariant 4 has been a review rule; Phase 2 is where it would first be broken, and a lint failure catches it before review does. |
| Q11 | **Profiles are validated before anything is copied.** Pure tests in `packages/domain` check:<ul><li>**required keys:** every list is present and non-empty where the type needs it;</li><li>**unique identifiers** in each list;</li><li>**valid references:** every hierarchy rule names a unit type in the same profile; every cadre names a category; every approval stage names an office or a function held by a body; every qualification names regulators in the profile;</li><li>**supported types:** one template per institution type, and each loads on its own;</li><li>**qualification consistency:** each has a family, an award type and level labels, and an offered one is regulated;</li><li>**governance-body distinctions:** `senate` and `academic_board` are never in the same profile, and `academic_governing_body` is held by exactly one academic body;</li><li>**approval-chain integrity:** at least one mandatory stage, no stage twice, and a conditional stage names its condition;</li><li>**period and window consistency:** a `semester` period, and SIWES windows only where a SIWES period exists;</li><li>**version integrity:** each template's content hash is pinned in the test, so a change without a new version fails;</li><li>the profiles are frozen.</li></ul>A test also pins the differences the documents require. Integration tests check that assigning, or assigning again, doesn't mutate an institution's existing configuration. | Wrong data in a profile is copied into every institution of that type and then owned by each of them, so it has to be right before anything is copied. |

## Threats

No new rows. The snapshot's integrity is T40's concern in spirit, a starting point changed afterwards:
- the snapshot is append-only for the app's role (`UPDATE` and `DELETE` revoked), and only the purge, as the migrator, deletes it;
- its hash is checked against the platform's assignment.

A profile holds no personal data and no secret.

## Acceptance criteria

1. **The three profiles** pass Q11's checks, and their differences match the guidance documents (the appendix).
2. **A provisioned institution of each type** has:
   - its `institution_profile` snapshot;
   - an `ASSIGNED` `tenant_profile_assignment` with the same hash;
   - the audit `setup.profile_assigned`.

   A resumed or repeated step creates nothing new and changes nothing.
3. **An institution live before the release** (the seed's, the drill's, the stack's) gets its profile from `ProfilePass` or the seed. An `OFFBOARDING`, `ARCHIVED` or `PURGED` one doesn't, and nothing of it changes.
4. **The snapshot is append-only** for the app's role. It is visible only inside its own tenant (a cross-tenant test), is in the institution's export, and is deleted by the purge. `pnpm rls:check` passes.
5. **The lint rule** fails on a comparison with a type literal (a fixture), allows the permitted paths, and passes the codebase.
6. **The console** shows each institution's profile, version and status.
7. Released, deployed and checked on the stack by the owner: every institution on the stack shows an assigned profile in the console.

## The PR

One PR. It contains:
- the domain's profiles, their canonical hash and their checks;
- the tenant migration (`institution_profile`, forced RLS, append-only grants);
- the platform migration (`tenant_profile_assignment`, its checks and grants);
- `assignInstitutionProfile`, called from provisioning's step, the seed and `ProfilePass`;
- the export catalogue's entry and the purge's table order;
- the lint rule;
- the console's assignment fact, the contract and `contracts:gen`;
- the tests and the docs.

## The owner's steps

- ~~Approve or change Q1 to Q11 and the appendix.~~ Approved 2026-11-26, with refinements.
- **The ranks, governance bodies and approval defaults stay `[VERIFY]`:** they are what the documents describe. Each institution checks them against its own Scheme of Service and enabling law, in S3 and S5.
- ~~After the release and deploy: check that the console's institution pages show an assigned profile for each institution on the stack.~~ Done 2026-11-26.

## Affected docs

- [03](../03-domain-model.md) §3: `InstitutionProfile` becomes the snapshot, and the platform gains `TenantProfileAssignment`.
- [07](../07-data-and-database.md): the new tables, the snapshot append-only, and their grants.
- [05](../05-modules-and-features.md) §1: provisioning assigns the profile.
- [spec 0034](0034-provisioning.md): a note that the templates are `@2` from P2-S0.
- [spec 0040](0040-phase-2-institution-setup.md) Q2: refined by this spec's Q2 (noted in this PR).
- [17](../17-coding-standards.md): the lint rule and the principle.
- [19](../19-decision-log.md): ADR-039's enforcement.
- [18](../18-roadmap.md): P2-S0's progress.

## Out of scope

- **The editable tables:**
  - unit types and their hierarchy rules (S1);
  - staff catalogues, offices and bodies (S3);
  - qualifications (S4);
  - the approval chains (S5);
  - periods and windows (S6).

  Each projects its part of the snapshot.
- **Changing an institution's configuration, or "reset to the default"**: the slice that owns the part.
- **Upgrading live institutions to a newer profile version** (Q7).
- **A tenant screen for the profile** (Q8).
- **Which role each office grants** (S3).

## The PR: what was built

- **The profiles** (`packages/domain/src/platform/profiles.ts`): the appendix as frozen data, `profileProblems` (Q11's checks), and the three templates at `@2` with their profiles (`provisioning.ts`).
- **The content hash:** SHA-256 over the existing `canonicalJson` (spec 0037 Q3), computed in `packages/db` (`profileContentHash`).
  - `university@2`: `52a77041…2170`
  - `polytechnic@2`: `b561011e…0b29`
  - `college-of-education@2`: `6ba7744e…e0f8`

  The tests pin all three.
- **The tenant side:** `institution_profile` (forced RLS; the app may only insert and read) and `recordProfileSnapshot`, which writes once and refuses a different hash under the same version.
- **The platform side:** `tenant_profile_assignment`.
  - Its checks: the status and its fixed codes, and the hash's format.
  - A trigger keeps what was assigned unchanged, and an `ASSIGNED` row unchanged entirely.
  - Grants: the app's platform role may update only the status columns; the console may read.
- **`ProfileAssigner`** (`apps/api/src/modules/profiles`): open (`PENDING`), snapshot (with the audit `setup.profile_assigned`), close (`ASSIGNED`, with the platform's audit `platform.tenant.profile_assigned`), fail (`FAILED`, with its fixed code). Provisioning's `template` step uses it inside the settings' own tenant transaction.
- **`ProfilePass`** in the worker, at start and every 15 minutes (`PROFILE_PASS_INTERVAL_MS`).
- **The seed** asks for its institutions' profiles.
- **The export catalogue, the purge and the test cleanup** know both tables.
- **The lint rule** (`tools/lint/type-branching.mjs`), its tests (`node --test tools/lint/type-branching.test.mjs`, in CI), and both `no-restricted-syntax` blocks spreading it.
- **The console:** the institution's facts gain "Profile". The detail's contract gains `profileAssignment`.

**Tests:**
- **Unit:** the domain's 195 tests (`profiles.spec.ts`: every check, the pinned hashes, the differences the documents require), with `profiles.ts` at 100 % of lines.
- **Integration, run against the development databases:**
  - `profiles.int.spec.ts`, 8 tests: the statuses that get one and the ones that don't; the seed's request completed; running again creates nothing new and changes no configuration; a pass stopped after the snapshot is finished without a second audit; `hash_mismatch` recorded, then retried; the snapshot can't be updated or deleted; an `ASSIGNED` row can't change; cross-tenant.
  - Provisioning, the export catalogue, the tenant registry, the purge and the exports: 61 tests, updated for `@2`, the profile's audit and the console's field.
  - The tenant isolation sweep (spec 0004, `packages/db`): `institution_profile` has its fixture, so every read, write and delete across institutions is refused for it too (55 tests in that package).
- **E2E:** the console's provisioning journey now expects `polytechnic@2` and the profile line.
- **Mutation checks:** 11 mutants, each caught by a test:
  - Senate and Academic Board together;
  - a conditional stage without its condition;
  - a profile change without a new version;
  - NID offered;
  - the switch selector removed;
  - `db-ops` not permitted;
  - `OFFBOARDING` assigned;
  - a wrong hash accepted;
  - the audit written on every run;
  - no snapshot in the template step;
  - the console's field dropped.

### Decisions made while building (approved by the owner on 2026-11-26)

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **The seed only asks:** it writes the platform's row (`PENDING`, source `SEED`), and `ProfilePass` completes it (the snapshot, its audit, `ASSIGNED`) with the source kept. | The institution's audit writer (its hash chain) lives in the API; the seed writes no audit events. One assigning path keeps every assignment audited. Locally, the worker assigns them at start. |
| Q-A2 | **The pass records a failure on its row and carries on,** rather than failing the whole pass, unlike the offboarding pass. The worker logs the institution's id and the fixed code. | One institution on an unreachable shard must not mark every pass failed. Its row says `FAILED` with the code, for the console, and the next pass tries again. |
| Q-A3 | **The audits name the hash `sha256`,** not `contentHash`. | The audit's redaction (spec 0002 A6) blanks any key naming a hash or a code; `sha256` is how the export's records name theirs. |
| Q-A4 | **The assignment's foreign key to `tenant` cascades,** like the other configuration children (products, domains, branding). The purge still deletes it explicitly. | Tenants are never deleted in production: they're purged to a tombstone. The suites that delete their own tenants by hand mustn't fail because a running worker gave one a profile. |
| Q-A5 | **The console's field is `profileAssignment`.** | `tenantProfile` is already the route that edits an institution's names; `profile` would mean two things. |
| Q-A6 | **An institution provisioned at `@1` is assigned its template's current version (`@2`).** | `@1` had no profile; the template's id is what it chose. |
| Q-A7 | **The source never changes once recorded** (the app's role may not update it). | Where an assignment came from is history. |
| Q-A8 | **`packages/db-ops` depends on `@univarse/domain`:** the seed needs the templates. | The migrate image already builds its workspace dependencies (`turbo … --filter=@univarse/migrate...`). |
| Q-A9 | **A few values the appendix left open:**<ul><li>a university's bachelor's levels run to "600 Level" (MBBS);</li><li>postgraduate levels: a PGD "Year 1"; a master's to "Year 3"; a doctorate to "Year 5";</li><li>sub-degree diplomas "Year 1"–"Year 2" and certificates "Year 1";</li><li>the full names of the qualifications and regulators;</li><li>NSQ's regulator `[VERIFY]` (NCCE in the data).</li></ul>A programme uses the first N labels and S4 makes them editable. | Labels a type needs, without a code change, until S4's screens. |
| Q-A10 | **The root may contain every type,** implied rather than listed in the data. | It's the institution: General Studies and Entrepreneurship sit under it at the pilot. |

## Done: the release, the deploy and criterion 7

- **Released and deployed on 2026-11-26** as `e94e732` (record `releases/2026-11-26-e94e732.json`): five images built, scanned, signed, attested and verified; the five running on the stack are the release's own digests. The migrate job applied `20261126120000_profile_assignment` to the platform database and `20261126120000_institution_profile` to every shard.
- **On the way there:** the first run stopped at the PgBouncer Grype gate, because downloading Grype's database broke off (`unexpected EOF`): the network, not a finding. The database was downloaded on its own into the release's cache (`uv-grype-cache`, built 2026-11-26), and the second run passed every gate with no new exception.
- **Criterion 7, the owner's check on the stack, passed (2026-11-26):** every onboarding, active and suspended institution on the stack shows its type's profile, version 2, assigned, on its console page; no institution shows a failed or waiting assignment.
- **The backup:** the release and deploy finished before the backup's 13:30 run, so no manual backup was needed ([10 §4.2](../10-infrastructure-and-deployment.md)).

## Appendix: the profiles' contents

The entries are drawn from the owner's guidance documents. Words in quotes are each type's display names; keys are in `code`. Entries marked `[VERIFY]` depend on the institution's Scheme of Service, conditions of service or enabling law.

### Unit types and their hierarchy rules

| Key | Kind | May contain | University | Polytechnic | College of education |
| --- | --- | --- | --- | --- | --- |
| `college` | Academic | `faculty`, `school`, `institute`, `centre`, `department`, `academic_unit` | "College" | — | — |
| `faculty` | Academic | `department`, `institute`, `centre`, `academic_unit`, `unit` | "Faculty" | "Faculty" | — |
| `school` | Academic | `department`, `institute`, `centre`, `academic_unit`, `unit` | "School" | "School" | "School" |
| `department` | Academic | `academic_unit`, `unit`, `section` | "Department" | "Department" | "Department" |
| `academic_unit` | Academic | `section` | "Academic Unit" | "Academic Unit" | "Academic Unit" |
| `institute` | Research | `department`, `centre`, `unit`, `section` | "Institute" | — | — |
| `centre` | Research | `unit`, `section` | "Centre" | "Centre" | "Centre" |
| `directorate` | Administrative | `division`, `unit`, `section` | "Directorate" | "Directorate" | "Directorate" |
| `administrative_department` | Administrative | `division`, `unit`, `section` | "Administrative Department" | "Administrative Department" | "Administrative Department" |
| `division` | Administrative | `unit`, `section` | "Division" | "Division" | "Division" |
| `unit` | Administrative | `section` | "Unit" | "Unit" | "Unit" |
| `section` | Administrative | (nothing) | "Section" | "Section" | "Section" |

- **The root.** The root stays the institution itself, as provisioning creates it, and may contain every type in the profile. Non-faculty academic units, such as General Studies or Entrepreneurship, can therefore sit under the root.
- **A type a profile doesn't have** (marked —) isn't in any of its "may contain" lists.
- **S1 holds the tree's other rules:** one parent, no cycles, and an archived unit takes no new child.

### Qualifications, award types and level labels

| Type | Offered by default | Off by default |
| --- | --- | --- |
| University | B.Sc., B.A., B.Eng., B.Tech., LL.B., MBBS (bachelor's, "100 Level" to "600 Level"); PGD; M.Sc., M.A., MBA, M.Phil. (master's); Ph.D. (doctorate). Postgraduate levels are "Year 1", "Year 2" and so on | Diploma, Certificate (sub-degree) |
| Polytechnic | ND ("ND1", "ND2"), HND ("HND1", "HND2") | NID ("NID1", "NID2") `[VERIFY]`, Certificate, Professional Diploma |
| College of education | NCE ("NCE 100 Level", "NCE 200 Level", "NCE 300 Level") | B.Ed., B.A.(Ed.), B.Sc.(Ed.) ("100 Level" to "400 Level"); PGDE; NSQ |

- **The family** is what later rules are chosen by (spec 0040 Q10), never the institution's type. The families are `bachelor`, `postgraduate_diploma`, `master`, `doctorate`, `diploma`, `certificate`, `nd`, `hnd`, `nid`, `professional_diploma`, `nce`, `pgde` and `nsq`.
- **The award type** is `degree`, `diploma` or `certificate`.
- **Level labels:** a programme of N years uses the first N labels. Part-time arrangements are S4's.

### The default academic structure

- **All three types:** a session holds two semesters, "First Semester" and "Second Semester".
- **University:** an optional summer period.
- **Polytechnic and college of education:** special periods beside the semesters (below), never forced into one.

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

### Institutional offices

| Key | Scope | University | Polytechnic | College of education |
| --- | --- | --- | --- | --- |
| `institution_head` | Institution | "Vice-Chancellor" | "Rector" | "Provost" |
| `deputy_institution_head` | Institution | "Deputy Vice-Chancellor" | "Deputy Rector" | "Deputy Provost" |
| `registrar` | Institution | "Registrar" | "Registrar" | "Registrar" |
| `bursar` | Institution | "Bursar" | "Bursar" | "Bursar" |
| `librarian` | Institution | "University Librarian" | "Polytechnic Librarian" | "College Librarian" |
| `college_provost` | Unit | "Provost" (of a college) | — | — |
| `dean` | Unit | "Dean" | "Dean" | "Dean" |
| `deputy_dean` | Unit | "Deputy Dean" | "Deputy Dean" | "Deputy Dean" |
| `department_head` | Unit | "Head of Department" | "Head of Department" | "Head of Department" |
| `deputy_department_head` | Unit | "Deputy Head of Department" | — | — |
| `director` | Unit | "Director" | "Director" | "Director" |
| `examination_officer` | Unit | "Examination Officer" | "Examination Officer" | "Examination Officer" |
| `programme_coordinator` | Programme | "Programme Coordinator" | "Programme Coordinator" | "Programme Coordinator" |
| `level_coordinator` | Programme | "Level Coordinator" | "Level Coordinator" | "Level Coordinator" |
| `course_adviser` | Programme | "Course Adviser" | "Course Adviser" | "Course Adviser" |
| `siwes_coordinator` | Unit | "SIWES Coordinator" | "SIWES Coordinator" | "SIWES Coordinator" |
| `teaching_practice_coordinator` | Unit | — | — | "Teaching Practice Coordinator" |

### Governance bodies `[VERIFY]`

The kinds are:
- **academic:** academic governance;
- **administrative:** policy, oversight and management;
- **assembly:** a body of members, not a decision-maker in an approval chain.

| Key | Kind | Function | Scope | University | Polytechnic | College of education |
| --- | --- | --- | --- | --- | --- | --- |
| `governing_council` | Administrative | `governing_body` | Institution | "Governing Council" | "Governing Council" | "Governing Council" |
| `senate` | Academic | `academic_governing_body` | Institution | "Senate" | — | — |
| `academic_board` | Academic | `academic_governing_body` | Institution | — | "Academic Board" | "Academic Board" |
| `management_committee` | Administrative | `executive_management` | Institution | "University Management Committee" | "Management Committee" | "College Management Committee" |
| `unit_board` | Academic | `unit_academic_board` | Unit | "Faculty Board" | "School Board" | "School Board" |
| `congregation` | Assembly | — | Institution | "Congregation" | — | "Congregation" |
| `convocation` | Assembly | — | Institution | "Convocation" | — | "Convocation" |
| `academic_staff_congregation` | Assembly | — | Institution | — | — | "Academic Staff Congregation" |

### The default approval chains (spec 0040 Q5)

The curriculum's chain comes first. Later slices add other chains, such as results, under their own key.

| Type | Stage 1 | Stage 2 | Stage 3 |
| --- | --- | --- | --- |
| University | `department_head`, mandatory | `dean`, mandatory | `academic_governing_body` (Senate), **conditional**: on when the institution switches it on |
| Polytechnic | `department_head`, mandatory | `dean`, mandatory | `academic_governing_body` (Academic Board), mandatory |
| College of education | `department_head`, mandatory | `dean`, mandatory | `academic_governing_body` (Academic Board), mandatory |

External approval (NUC, NBTE, NCCE) is never a stage. S5 records it as its own event.

### Periods and windows

- **Period types:**
  - **all three types:** `semester`;
  - **university:** `summer`, and `siwes` where a programme has it;
  - **polytechnic:** `siwes` and `industrial_attachment`;
  - **college of education:** `teaching_practice`, and `siwes` where a programme has it.
- **Window types:**
  - **all three types:** `application`, `course_registration`, `late_registration`, `add_drop`, `fee_payment`, `score_entry`, `examination`, `hostel_application`, `clearance`, `graduation_processing`, `project_submission`;
  - **polytechnic:** also `siwes_application` and `siwes_assessment`.

### Regulators and what they regulate

| Type | Regulators | Qualifications each regulates |
| --- | --- | --- |
| University | NUC | every qualification |
| Polytechnic | NBTE | every qualification |
| College of education | NCCE, NUC | NCE and PGDE: NCCE. NSQ: NCCE `[VERIFY]`. The degree families: NCCE and NUC, both, under the dual mandate |
