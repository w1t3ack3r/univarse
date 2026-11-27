# Spec 0042: Phase 2's P2-S1, the org tree

**Status:** **Approved by the owner on 2026-11-26, all as written** (Q1 to Q16, and the `[VERIFY]` limits until the pilot's real files test them). PR A is being built (its design is below).
**Phase:** 2, slice **P2-S1** of [spec 0040](0040-phase-2-institution-setup.md) ("The org tree").
**Builds on:**

- [spec 0040](0040-phase-2-institution-setup.md) (approved 2026-11-26): Q2 (configurable unit types), Q11 (code locks), Q12 (effective-dated change), Q14 (the `ORG_UNIT` scope), T41 (authority widening through the structure), T45 (an identifier losing its meaning);
- [spec 0041](0041-institution-profiles.md) (done 2026-11-26): the profile snapshot holds each type's unit types, their kinds, names and hierarchy rules (its Q2, Q4 and appendix). **S1 projects that part** into the institution's own editable table;
- [ADR-028](../19-decision-log.md): resource scopes arrive with their first consuming module; `ORG_UNIT` is this one;
- [spec 0018](0018-policy-service.md): the one place a permission is decided (`evaluate()`), and a check against a scope it doesn't know doesn't type-check;
- **the owner's Phase 2 guidance documents (2026-11-26), kept locally:** the university draft's §1 (1.1 to 1.5) and the polytechnic draft's §1 (one tree engine for both, each type's own words);
- **the owner's synthetic pilot set (2026-11-26), kept locally:** its structure sheet has a department with no code yet ("to be assigned by Senate"), non-faculty units under the institution itself (GST, ENT), and a note that the computing departments move to a new faculty from 2026/27;
- [04 §11](../04-business-rules.md): a matric number keeps the unit codes it was issued with.

## Why

Every later product points at the tree:
- a programme is owned by a department (S4);
- an appointment as HOD is scoped to one (S3);
- a matric number carries a faculty's and a department's codes (Phase 3);
- a window can be overridden per school (S6).

Today an institution has one unit, its root, and a fixed list of types in an enum. S1 gives it the real tree:
- its own unit types and words;
- the operations to build and restructure the tree;
- a history that can say what the structure was on any date;
- codes that stop meaning something else once they are used.

S1 also gives the policy its first resource scope, so a grant on a faculty covers that faculty and nothing else.

## What exists today

- **`org_unit`** (tenant):
  - `code` (unique per institution), `name`, `kind` (`ACADEMIC`/`ADMINISTRATIVE`), `type` (the enum `INSTITUTION` … `UNIT`);
  - `parent_id`, a materialised `path` of ancestor ids (`/<root>/<faculty>/<dept>/`), `status` (`ACTIVE`/`ARCHIVED`, the shared `RecordStatus` enum) and `version`;
  - forced RLS.
- **`seedTenantBase`** creates the root (code `ROOT`, type `INSTITUTION`, the institution's name) for the seed and for provisioning. **No institution, on the stack or in development, has any other unit.**
- **The permissions** `org.unit.view` and `org.unit.manage` (privileged) exist and are seeded to roles, but **no route uses them**, and there is no screen.
- **`role_assignment.scope_type`** already allows `ORG_UNIT`, but the policy counts only `INSTITUTION` grants (spec 0018 D4), and **no route or screen grants a role with a scope.**
- **The profile snapshot** (`institution_profile`) holds each institution's unit types with `key`, `kind` (`academic`/`administrative`/`research`), `name` and `mayContain`.

## Decisions (approved)

| # | Decision | Recommendation, and why |
| --- | --- | --- |
| Q1 | **Unit types become the institution's own table, `org_unit_type`:** key, name, kind (`ACADEMIC`, `ADMINISTRATIVE` or `RESEARCH`), the types it may contain, its order in lists, and its status (`ACTIVE` or `ARCHIVED`). **It is projected from the institution's profile snapshot:** by S1's migration for every institution already live (in SQL, from its latest `institution_profile`), and by the profile's assignment for new ones, in the same transaction as the snapshot. A type already there is never overwritten. | Spec 0041 Q4: each slice projects its own part, and nothing later overwrites an institution's edits. The rules ("may contain") are a separate child table, so a rule can be checked in SQL and referenced by key. |
| Q2 | **The institution edits its unit types:**<ul><li>rename a type ("School" for "Faculty");</li><li>change what it may contain;</li><li>add its own type, whose key is made once from its first name and never changes;</li><li>archive a type: no new unit of that type, and existing units keep it.</li></ul>**A type's kind and key never change.** A type in use can't be deleted, only archived. A changed rule applies to new placements and moves only. A unit that no longer fits the new rules stays where it is, and the tree marks it "doesn't follow the current rules", so nothing restructures itself. | The documents' first decision (no fixed hierarchy, the institution's own words), within spec 0041's rule that the institution owns its copy. Re-validating the whole tree when a rule changes would make a rule change a restructuring. |
| Q3 | **The tree's rules,** in `packages/domain` as pure functions and enforced again in the database where it can:<ul><li>**one parent,** except the root;</li><li>**never its own ancestor** (a move under itself or a descendant is refused);</li><li>**a child's type is one its parent's type may contain.** The root may contain every active type (spec 0041's appendix);</li><li>**an inactive or archived unit takes no new child,** and nothing moves under it;</li><li>**a unit is archived only when its children are already archived:** archiving is leaf first, with the count of active children in the refusal;</li><li>**a depth limit of 8 levels below the root** `[VERIFY]`, and **5,000 units per institution** `[VERIFY]`.</li></ul> | The documents' §1.4, and spec 0040 Q12. Leaf-first archiving means one decision closes one unit, so a click can't close a faculty and its twenty departments. The limits are guards against a runaway import (T42), set well above the pilot's 27 units. |
| Q4 | **The root is the institution.** It has no unit type. It can't be moved, archived or deactivated. Its name is the institution's name: edited only on the institution's profile page (spec 0033), which renames the root in the same transaction and records the change in the root's history. Its code stays `ROOT`, internal and never shown or used in an identifier. | The documents' "provisioning creates the root". One name for the institution, in one place. |
| Q5 | **A unit's status is `ACTIVE`, `INACTIVE` or `ARCHIVED`:**<ul><li>**inactive** (deactivated): shown in the tree, still in scope, but takes no new child or, later, no new programme or student. Reversible;</li><li>**archived:** closed, hidden from the tree unless "Show archived" is on, and kept with its history. Reactivating it needs step-up.</li></ul>**No unit is ever deleted.** Every unit has a history from its creation. A mistake is archived, and archived units are hidden by default. | The documents ask for "activate, deactivate or archive" and say referenced units are never deleted (spec 0040 Q12). Allowing a delete for units "with no references" would still destroy their history, and the history is append-only. |
| Q6 | **Every change is effective-dated and kept: `org_unit_change`.** It records:<ul><li>the change's kind: `CREATED`, `RENAMED`, `DESCRIBED`, `RETYPED`, `MOVED`, `CODE_CHANGED`, `CODE_CORRECTED`, `DEACTIVATED`, `ARCHIVED` or `REACTIVATED`;</li><li>the unit's state after it (code, name, type, parent, status);</li><li>its effective date, a calendar date in `Africa/Lagos`;</li><li>who made it, and why. A reason is required for a move, an archive and a code change.</li></ul>**It is append-only** (`UPDATE` and `DELETE` revoked from the app's role). **"As at a date"** is read from it: each unit's latest change effective on or before that date. A unit with none on that date didn't exist yet. | Spec 0040 Q12: transcripts, staff history, accreditation and audits need the structure as it was. Storing the state after each change makes "as at" one query, with no replay. |
| Q7 | **An effective date is today or earlier, never in the future.** A change may be back-dated, for example to record that a move took effect at the start of the session. A unit's changes stay in date order: a change's date is on or after its unit's previous change's date, and a move's date is on or after the new parent's creation date. **Scheduled future changes are out of S1.** The pilot's "computing moves to a new faculty from 2026/27" is done by creating the new faculty now, inactive, and making the moves on the day. | A future-dated change would make the tree in force differ from the tree in the table until a worker applies it, and scope would then depend on a job having run. Back-dating keeps the record honest without that. Scope is always decided on the tree as it is now (T41). |
| Q8 | **Codes:**<ul><li>trimmed and upper-cased; 2 to 12 letters and digits, starting with a letter;</li><li>**unique among every code the institution has ever used**, current or former, archived units included, so a code never comes to mean a different unit;</li><li>**optional until assigned.** A unit may have no code yet ("No code yet" in the tree). Phase 3 refuses to issue an identifier for a unit with none.</li></ul> | The pilot has a department whose code is "to be assigned by Senate", and its answer key expects it to import. A reused code would make an old matric number point at the wrong department (T45). |
| Q9 | **A code is locked once it is used in an issued identifier** (spec 0040 Q11). `code_locked_at` on the unit, set by whatever issues the identifier (Phase 3), and never cleared. **The lock changes what a code edit means:**<ul><li>**unlocked:** an edit is a correction (`CODE_CORRECTED`). The old code is released and may be used again;</li><li>**locked:** the code can't be corrected. A new code is a `CODE_CHANGED`, with step-up, an effective date and a reason. The old code stays reserved for ever, and the screen says that issued identifiers keep the old code.</li></ul>A database trigger refuses a change to a locked unit's code that isn't recorded as `CODE_CHANGED`, and refuses clearing the lock. S1 builds the lock and its rules. Nothing sets it until Phase 3. | The documents: a code used in a matric number "must not be silently changed". A correction before any number exists is harmless. After one exists, it's a decision with a date. |
| Q10 | **Changing a unit's type** is allowed when its parent's type may contain the new type and the new type may contain each of its children's types. Recorded as `RETYPED`. A unit's kind is its type's, so an academic unit doesn't silently become administrative: retyping across kinds is refused. | Institutions rename "School" to "Faculty" by renaming the type (Q2). Retyping one unit is a correction. |
| Q11 | **Moving a unit** (re-parenting):<ul><li>its whole subtree moves with it, and every path below it is rewritten, in one transaction;</li><li>it takes the unit's `If-Match` version, an effective date, a reason and step-up;</li><li>the confirmation says how many units move, and that roles scoped to the old parent no longer cover them;</li><li>**drag-and-drop opens the same confirmation**, never moves on drop. **"Move unit"** is the accessible way, a dialog with a searchable parent picker. On a phone, only "Move unit" is offered.</li></ul>Rows are locked in a fixed order (the unit, then the new parent), so two moves can't build a cycle between them. | The documents' §1.3 and spec 0040 T41: a move silently changes who has authority over a unit, so it is deliberate, confirmed, dated and audited. |
| Q12 | **Permissions:**<ul><li>`org.unit.view` (existing): see the tree, a unit and its history;</li><li>`org.unit.manage` (existing, privileged): create a unit, edit its name, description and an unlocked code, and deactivate or reactivate a unit;</li><li>**new `org.unit.restructure`** (privileged, step-up): move, retype, archive and reactivate from archived, and change a locked code;</li><li>**new `org.unit_type.manage`** (privileged, step-up): the unit types and their rules. It is counted only at the institution's scope.</li></ul>**Seeded:**<ul><li>`INSTITUTION_ADMIN` and `REGISTRAR` hold all four;</li><li>`MANAGEMENT_VIEWER` gains `org.unit.view`;</li><li>`DEAN`, `HOD` and `LECTURER` keep `org.unit.view`.</li></ul>A Dean's scoped management arrives with S3's appointments. | The documents' §1.5: the Registrar manages the structure, an auditor reads it and its history, and permissions are the institution's to change (roles are editable), never fixed to job titles. Restructuring is split from editing because it moves authority (T41). |
| Q13 | **The `ORG_UNIT` scope (ADR-028, spec 0040 Q14), in the policy:**<ul><li>`ResourceContext` gains `{ scope: 'ORG_UNIT', unitId, path }`, built from the **loaded** unit;</li><li>a grant scoped to unit X covers a resource whose path contains X, so a grant on a faculty covers its departments;</li><li>an institution grant covers everything, as now.</li></ul>**For a move,** the actor needs the permission on the unit and on the new parent, so nothing can be moved out of, or into, someone's reach without both. **A list** returns only the units an actor's grants cover; out of scope is 404. **The first way to hold a scoped grant is S3's appointments.** S1's tests create the grants directly. | Scope against the loaded resource (invariant 2), with no extra query: the path already holds every ancestor's id. |
| Q14 | **The API** (`@Product('core')`):<ul><li>`GET /org/units`: the whole tree as one flat list, bounded by Q3's 5,000 units, rather than paged. It takes `?asAt=` (Q6), `?status=` and `?q=` (name or code);</li><li>`GET /org/units/:id`, with its `ETag`, and `GET /org/units/:id/history`;</li><li>`POST /org/units`, and `PATCH /org/units/:id` with `If-Match`;</li><li>`POST /org/units/:id/move`, `/deactivate`, `/archive`, `/reactivate` and `/code`;</li><li>`GET` and `PUT /org/unit-types`.</li></ul>Each write is idempotent by its `Idempotency-Key`, and is audited (`org.unit.created`, `org.unit.moved` and the rest, `org.unit_type.changed`) in the same transaction as its change row. | One fetch builds the tree in the browser, which keeps search, expand and collapse instant. Paging a tree breaks it into pieces that can't be drawn. docs/06's conventions otherwise. |
| Q15 | **No outbox event yet.** Other products will read the tree through Core's published contract (ADR-020), and an `org.unit.changed` event is added with its first consumer (Phase 3's identifiers). | An event with no consumer is a contract nobody tests. The audit already records every change. |
| Q16 | **The old `type`, `kind` and `status` columns are retired by expand → migrate → contract** (invariant 9):<ul><li>**this release (expand):** it adds `org_unit.type_id` (each root's stays null, Q4) and a new `state` column of its own enum, `OrgUnitStatus` (`ACTIVE`, `INACTIVE`, `ARCHIVED`). **The new code keeps writing the old columns with values the earlier images can read:**<ul><li>`kind`: `ADMINISTRATIVE` for an administrative type, otherwise `ACADEMIC`;</li><li>`type`: the enum value matching the type's key where there is one, otherwise `UNIT`;</li><li>`status`: `ARCHIVED` for an archived unit, otherwise `ACTIVE`.</li></ul></li><li>**a later release (contract):** it drops `type`, `kind`, `status` and the two old enums, once no running image reads them.</li></ul> | Today only the roots exist, so the backfill is the roots only. **A rollback to the earlier images stays safe after units are created:** every row still has the old columns, with values the old client knows. A new enum value (`INACTIVE`) in the old column would make the earlier images fail to read the table, so it goes in the new column. `RecordStatus` stays as it is for its other users. |

## Threats

No new rows. S1 is where two of spec 0040's take effect:
- **T41, authority widening through the structure:**
  - moves need `org.unit.restructure` with step-up, on both the unit and the new parent;
  - they are audited with their effective date and reason;
  - scope is decided on the tree as it is at the request, from the loaded unit.
- **T45, an identifier losing its meaning:**
  - codes are unique across every code ever used;
  - a locked code can't be corrected, only changed with a date, keeping the old one reserved;
  - a database trigger holds both rules.

A unit's names and codes aren't personal data. The history records who made each change, as the audit does.

## Acceptance criteria

1. **Unit types:**
   - every institution live before the release has its profile's unit types after the migration;
   - a new institution has them from its profile's assignment;
   - an edited type is never overwritten.
2. **The tree's rules** (Q3, Q7, Q8, Q10):
   - each rule is tested as a pure function, with a mutation check;
   - a cycle, a forbidden child type, a child under an archived or inactive unit, an archive with active children, a future date, an out-of-order date and a reused code are each refused by the API.
3. **A move** rewrites its subtree's paths in one transaction. It needs step-up and `If-Match`. It is audited with its date and reason. Two concurrent moves that would build a cycle can't both succeed.
4. **"As at a date"** returns the tree as it was: a unit created later is absent; a unit moved since is under its old parent, with its old name and code.
5. **The code lock:** a locked code can't be corrected or unlocked, through the API or by an `UPDATE` in the database. A `CODE_CHANGED` keeps the old code reserved.
6. **The history is append-only** for the app's role. The new tables are in the export, deleted by the purge, and isolated by RLS (a cross-tenant test). `pnpm rls:check` passes.
7. **The `ORG_UNIT` scope** (spec 0040 acceptance 4):
   - a grant on a faculty covers its departments, and not a sibling faculty;
   - a move needs the grant on both the unit and the new parent;
   - out of scope answers 404;
   - every new route declares its permission, with a positive and a negative test.
8. **The screens** (PR B):
   - the tree: expand and collapse, search, "Show archived", "as at";
   - a unit's details and history;
   - create, edit, deactivate, archive and reactivate;
   - "Move unit", and drag-and-drop on desktop;
   - the unit types page.

   E2E on desktop and phone, with axe. "Move unit" is usable by keyboard alone.
9. Released, deployed and checked on the stack by the owner:
   - in `demo-uni`, build a small tree (a faculty, two departments, the registry), move a department, and read the tree as at yesterday;
   - in `test-poly`, the types read "School".

## The PRs

**PR A, the model and the API:**
- the migrations: `org_unit_type` and its rules, `org_unit_change`, `org_unit.type_id`, `description`, `code_locked_at`, the code reservations, `OrgUnitStatus`, the projection for live institutions, the lock trigger, grants and RLS;
- the domain's tree rules;
- the projection at the profile's assignment;
- the `ORG_UNIT` scope in the policy;
- the routes, the permissions, the audit labels, the contract and `contracts:gen`;
- the export catalogue, the purge, the tenant cleanup and the isolation sweep;
- a small demo tree in the seed, for development and the E2E;
- the tests and the docs.

**PR B, the screens:** the web app's Structure page (the tree, a unit's panel and history, the dialogs, drag-and-drop) and the unit types page, through `/impeccable` with `--target apps/web`, then E2E and axe.

## The owner's steps

- ~~Approve or change Q1 to Q16.~~ Approved 2026-11-26.
- The `[VERIFY]` limits (Q3), 8 levels below the root and 5,000 units per institution, stand until the pilot's real files test them.
- After the release and deploy: criterion 9 on the stack.

## Affected docs

- [00](../00-glossary.md): unit type, effective date, "as at", code lock.
- [03](../03-domain-model.md) §3:
  - `OrgUnitType` built, with its rules;
  - `OrgUnit` with `typeId`, `description`, `codeLockedAt` and three statuses;
  - `OrgUnitChange` built, with its kinds.
- [04](../04-business-rules.md): the tree's rules, effective dates, and codes and their lock (§11).
- [05](../05-modules-and-features.md) §3: the org tree's acceptance criteria, as built.
- [06](../06-api-guidelines.md): a bounded tree returned whole, not paged.
- [07](../07-data-and-database.md): the new tables, the append-only history, the lock trigger, and the old columns' expand and contract.
- [08](../08-security.md) §4: the new permissions, and the `ORG_UNIT` scope enforced.
- [12](../12-testing-strategy.md): the scope's positive and negative tests.
- [18](../18-roadmap.md): P2-S1's progress, and the contract migration as an open item.
- [19](../19-decision-log.md): ADR-028's `ORG_UNIT` scope built.

## Out of scope

- **Importing units** (P2-S2, through the import framework; the pilot's structure sheet is its first test).
- **Leadership on a unit's page** (S3's appointments), **its programmes** (S4), **its staff and students** (S3, Phase 4). Until then the unit's page shows only what exists. No placeholder sections.
- **Granting a role scoped to a unit** (S3, through appointments).
- **Scheduled future changes** (Q7).
- **Issuing identifiers, and so setting the code lock** (Phase 3).
- **The contract migration** that drops the old columns and enums (Q16): a later release.
- **An `org.unit.changed` event** (Q15).

## PR A: the design

### The tables (tenant, one migration, expand only)

- **`org_unit_type`:**
  - `key` (`^[a-z][a-z0-9_]{1,39}$`, unique per institution, never changed), `name` (1 to 60 characters), `kind` (`OrgUnitTypeKind`: `ACADEMIC`, `ADMINISTRATIVE`, `RESEARCH`, never changed), `sort_order`, `status` (`ACTIVE`/`ARCHIVED`), `version`;
  - forced RLS. The app may insert and update it, never delete (Q2: a type is archived, never deleted).
- **`org_unit_type_rule`:** (parent type, child type), both the institution's. The app inserts and deletes rows (a changed "may contain").
- **`org_unit` gains:**
  - `type_id` (the institution's type; null exactly for the root, a `CHECK`);
  - `state` (`OrgUnitStatus`: `ACTIVE`, `INACTIVE`, `ARCHIVED`);
  - `description` (up to 500 characters);
  - `code_locked_at`;
  - `creation_key` (Q-A2).

  **`code` becomes nullable** (Q8), and gets a format `CHECK` (`^[A-Z][A-Z0-9]{1,11}$`). One root per institution (a partial unique index).
- **`org_unit_code`, the code reservations** (Q8): `code` unique per institution, and the unit that holds it.
  - Every unit's current code has its row: a deferred foreign key from (`tenant_id`, `id`, `code`) to it.
  - A correction deletes the old row, which releases the code. A changed locked code keeps its row, so the code stays reserved.
  - The app inserts and deletes rows, never updates them.
- **`org_unit_change`:**
  - `seq` (an identity column, the order within a day);
  - `kind` (`OrgUnitChangeKind`, Q6's ten kinds);
  - the state after the change: `code`, `name`, `description`, `type_id`, `parent_id`, `state`;
  - `effective_from` (a `date`), `actor_id`, `reason`, `created_at`.

  Append-only: `UPDATE`, `DELETE` and `TRUNCATE` revoked from the app's role.

### The database's own rules

- **A deferred constraint trigger on `org_unit`** checks, at commit, every row inserted or whose parent, path, type or state changed:
  - its `path` is its parent's path plus its own id (the root's is its own id), so a cycle can't be stored;
  - a new or moved active unit's parent is active, and its parent's type may contain its type (or the parent is the root).

  It is deferred because a move rewrites a whole subtree's paths in one statement.
- **A trigger on `org_unit` guards the lock** (Q9): `code_locked_at` can't be cleared, and a locked unit's code can change only if its old code keeps its reservation.
- **A trigger on `org_unit_code`** refuses deleting the reservation of a unit whose code is locked.
- **The migration projects the unit types** of every institution with a profile snapshot, from its latest `institution_profile`, and their rules. Then it:
  - gives each root its `state`;
  - reserves each existing code;
  - writes each existing unit's `CREATED` change, effective from its creation date;
  - gives the new permissions to the system roles (Q12), as `20261119120000_data_export` did.

### The code

- **`packages/domain/src/org/`:**
  - the tree's rules as pure functions (Q3, Q7, Q8, Q10);
  - the old columns' compatible values (Q16);
  - the type key made from a name;
  - today's date in `Africa/Lagos`.
- **`packages/db`:**
  - `projectUnitTypes(tx, tenantId, unitTypes)`, called by the profile's assignment when the institution has no unit types yet;
  - `seedTenantBase` reserves the root's code and writes its `CREATED` change.
- **The policy:**
  - `ResourceContext` gains `{ scope: 'ORG_UNIT', unitId, path }`, and `covers` gains its path rule;
  - `holdsSomewhere(actor, permission)`, for a route's first gate.
- **The access guard:** a new `@RequireScopedPermission(permission)` admits an actor who holds the permission at some scope (otherwise 403). The service then decides against the loaded unit with `enforceOn` (out of scope is 404; MFA and step-up as usual). The OpenAPI document gives both decorators' permission.
- **`apps/api/src/modules/org/`** (`@Product('core')`): the controller and its services. Each write runs in one transaction:
  1. the unit's row is locked, `FOR UPDATE`;
  2. the version is checked (`If-Match`);
  3. the rules are checked;
  4. the row and its subtree are written, then the change rows;
  5. the audit is written.
- **The routes:**

  | Route | Permission (on) | Notes |
  | --- | --- | --- |
  | `GET /api/v1/org/units` | `org.unit.view` (each unit) | `?asAt=YYYY-MM-DD`, `?includeArchived=true`, `?q=`. Out-of-scope units are left out |
  | `GET /api/v1/org/units/:id` | `org.unit.view` (the unit) | `ETag`; its ancestors (for the breadcrumb), its type, its counts of children |
  | `GET /api/v1/org/units/:id/history` | `org.unit.view` (the unit) | Newest first, with who made each change |
  | `POST /api/v1/org/units` | `org.unit.manage` (the parent) | `Idempotency-Key` required (Q-A2). 201 with `ETag` |
  | `PATCH /api/v1/org/units/:id` | `org.unit.manage` (the unit); `org.unit.restructure` to retype | `If-Match`. Name, description, an unlocked code, the type |
  | `POST /api/v1/org/units/:id/move` | `org.unit.restructure` (the unit and the new parent) | `If-Match`, reason |
  | `POST /api/v1/org/units/:id/deactivate` | `org.unit.manage` | `If-Match` |
  | `POST /api/v1/org/units/:id/archive` | `org.unit.restructure` | `If-Match`, reason |
  | `POST /api/v1/org/units/:id/reactivate` | `org.unit.manage` from inactive; `org.unit.restructure` from archived | `If-Match` |
  | `POST /api/v1/org/units/:id/code` | `org.unit.restructure` | A locked unit's new code: `If-Match`, reason |
  | `GET /api/v1/org/unit-types` | `org.unit.view` (anywhere) | Each type with its rules and the number of units of that type |
  | `PUT /api/v1/org/unit-types/:key` | `org.unit_type.manage` (the institution) | Creates or edits one type (Q-A3). `If-Match` (`"v0"` for a new one) |

  Each write takes an optional `effectiveFrom` (today in `Africa/Lagos` by default).
- **The audit actions:** `org.unit.created`, `org.unit.updated`, `org.unit.moved`, `org.unit.code_changed`, `org.unit.deactivated`, `org.unit.archived`, `org.unit.reactivated` and `org.unit_type.saved`. Each holds the change's kinds, the before and after of what changed, the effective date and the reason.
- **The seed** gives `demo-uni` a small tree (a faculty with two departments, the registry) and `test-poly` a school with one department, for development and the E2E.
- **The export, the purge, the tenant cleanup and the isolation sweep** gain the new tables.

### Decisions made while building, for the owner's approval

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **The root shows the institution's current legal name, read from the registry,** not the name stored at provisioning. The institution's names stay edited only in the console, and the root's own name isn't edited anywhere. Q4 expected "the profile page renames the root in the same transaction". | The names live in the platform's database and the root in the institution's. No transaction spans both. Showing the registry's name keeps one name in one place. The console's audit already records each rename. |
| Q-A2 | **A create's `Idempotency-Key` is stored on the unit it made** (`creation_key`, unique per institution), rather than in a key store with stored responses. A replay by the same person answers with that unit. A replay by someone else is refused (409). Every other write is protected by `If-Match`: a replay finds a newer version and gets 412, never a second effect. | The tenant API has no idempotency store yet (docs/06 §5 lists the routes that need one, S2's import commit among them). One column gives the guarantee without one. |
| Q-A3 | **Unit types are saved one at a time** (`PUT /org/unit-types/:key`), each with its own version, rather than the whole set in one `PUT`. | Two administrators editing different types don't overwrite each other. |
| Q-A4 | **A type is projected only into an institution that has no unit types yet.** | A type the institution archived, or a rule it removed, is never brought back by a later assignment. Spec 0041 Q7 already says upgrades are explicit. |
| Q-A5 | **`code_locked_at` stays set after a locked code is changed,** so the new code is treated as locked too: it can be changed with a date and reason, never corrected. | Q9 says the lock is never cleared. Treating the new code as locked is the safe side. It costs only the ability to fix a typo in a code that issued identifiers may soon carry. |
| Q-A6 | **A `PATCH` that changes several things writes one change row per kind,** with the same date, in a fixed order. | "As at" takes each unit's last change, and each row stays one kind, as Q6 lists them. |
| Q-A7 | **The root's creation date bounds nothing:** a faculty may be created, or moved under the root, with any past date. Below the root, a unit's date is never before its parent's creation. | The institution existed long before its UniVarse account (the root is created at provisioning, today). An import of the real structure (S2) needs its founding dates. |
| Q-A8 | **The audit names a unit's code `acronym`.** | The audit's redaction (spec 0002 A6) blanks any key naming a code, as spec 0041's Q-A3 found for a hash. A unit's code isn't a secret. |
| Q-A9 | **The seed projects its institutions' unit types itself,** from the same template the pass assigns (the pass then finds them there and changes nothing), and gives `demo-uni` a small tree (Faculty of Science `SCI` with `CSC` and `MTH`, the Registry `REG`) and `test-poly` one school (`SICT` with `CSC`). | The seed runs before the worker, so its institutions have no types when it runs; development and the E2E need a structure. The codes match the seeded student's matric number (`25/SCI/CSC/0001`). |
| Q-A10 | **The code's two checks (its format, and its reservation) are added `NOT VALID`**: they bind every row written from now on and leave rows from before untouched. The contract release validates them. | A development database holds roots left by old isolation-test runs, with codes and paths the new rules refuse; the stack's roots all hold `ROOT`. Expand-only migrations don't rewrite data. |
| Q-A11 | **`org_unit_type_rule` has its own `id`,** with the pair unique. | The isolation sweep checks every tenant table by row id. |
| Q-A12 | **The list filters by scope in its SQL** (docs/06 §6); for a unit whose parent is outside the caller's scope, only that parent's type id is read, to say whether the unit follows the rules. | A list never loads what it doesn't return. The parent's type id says nothing of the parent. |
| Q-A13 | **Reactivating declares `org.unit.manage` at the route;** reactivating an archived unit needs `org.unit.restructure`, decided on the loaded unit (as a setting's own manage permission is, spec 0007). | Which one applies depends on the unit's state, which the route can't know. The contract's summary says so. |
| Q-A14 | **The tests use institutions of their own** (`org-…`, removed at the end), and a helper that writes units as the API does. **The route sweep archives its own units at the end**, as the migrator. | Units are never deleted, so tests on `demo-uni` would pile up in it on every local run. |

