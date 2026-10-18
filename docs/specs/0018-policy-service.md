# Spec 0018: PolicyService — one place decides every permission, with negative coverage for every resource scope

**Status:** **Accepted (2026-10-18)** by the owner: revision 1, D1–D6 as written. **Implemented**; see [Implementation notes](#implementation-notes).
**Phase:** 0. Closes the remaining half of the Phase 0 line "roles/permissions/scoped assignments, `PolicyService`" as split by [ADR-028](../19-decision-log.md): the central `PolicyService` and the negative tests. Resource scopes stay deferred to their first consuming modules (ADR-028).
**Builds on:**

- [ADR-028](../19-decision-log.md): institution scope now; resource scopes with their modules; a `PolicyService` that reuses today's logic;
- [08](../08-security.md) §4: deny by default, the permission catalog, `PolicyService.can(actor, permission, resourceContext)` as a pure, matrix-tested function, 404 for out-of-scope objects;
- [spec 0001](0001-password-reset-mfa-step-up.md): MFA for privileged permissions (M-series), step-up (S1–S9);
- CLAUDE.md invariant 2: every endpoint declares a permission; use cases check scope against the loaded resource.

## Why

Permission decisions are made in four places today, each with its own copy of the rule:

- `AccessGuard` via `enforcePermission` (`apps/api/src/modules/identity/access.guard.ts`): held institution-wide, then MFA if privileged, then a fresh step-up if the catalog flags it;
- `canInstitutionWide` (`actor.ts`), the scope rule itself: a grant counts only when `scopeType === 'INSTITUTION'`;
- `SettingsService` (`canManage` per setting) calls `canInstitutionWide` directly;
- `/auth/me` lists the caller's permissions by filtering grants on `scopeType` itself.

They agree today. Nothing makes them keep agreeing: a fifth caller can read `actor.grants` and decide differently, and the resource scopes (ADR-028) would each have to be added to every copy. ADR-028 also records that **no test proves** a grant scoped to `ORG_UNIT`, `PROGRAMME`, `COHORT`, `COURSE_OFFERING` or `HOSTEL` fails an institution-wide check. That safety holds by construction today, untested.

Two smaller gaps:

- The database lets an `INSTITUTION` assignment carry a `scope_id`, and a resource-scoped one carry none: the schema comments say "null only for INSTITUTION scope", but nothing enforces it.
- docs/08 §4 describes "a per-session permission cache (invalidated on `identity.role_*` events)". There is none: grants are loaded in each request's session lookup, which is why a removed role takes effect on the very next request (tested). The doc is wrong, not the code.

## Decisions

| #  | Decision | Recommendation |
| -- | -------- | -------------- |
| D1 | **Where the policy lives.** (a) A pure `evaluate()` in the identity module (`apps/api/src/modules/identity/policy.ts`), next to the `Actor` type, with an injectable `PolicyService` that wraps it. (b) In `packages/domain`, as a business rule. | **(a).** It is authorization, not an institutional business rule (invariant 4 is about rules like grading and fees); it needs the API's `Actor` and the contracts' permission catalog, and nothing outside the API evaluates it. It stays a pure function, matrix-tested, as docs/08 says. |
| D2 | **The resource context.** A discriminated union with **one** variant today, `{ scope: 'INSTITUTION' }`. Each resource scope adds its own variant (and its containment check against the loaded resource) with its first consuming module, per ADR-028. | **As written.** A check against a scope that doesn't exist yet is a **type error**, not an inert branch. |
| D3 | **One decision, three outcomes of refusal.** `evaluate()` returns `allow`, or a refusal naming its reason: `forbidden`, `mfa_required` or `step_up_required`, in that order of precedence (today's). `AccessGuard` and `enforcePermission` map them to the same problem responses as today (403 `auth.forbidden`, 403 `auth.mfa_required`, 428 `auth.step_up_required`). | **As written.** Behaviour is unchanged; only where it's decided moves. |
| D4 | **Malformed grants are inert.** An `INSTITUTION` grant with a non-null `scopeId`, or a grant whose scope type the policy doesn't know, never satisfies any check. **And** the database gets a `CHECK ((scope_type = 'INSTITUTION') = (scope_id IS NULL))` on `role_assignment`, added `NOT VALID` then validated in the same migration (no such rows should exist: the seed and the test harness write only institution grants, and no endpoint assigns roles yet). | **Both.** The policy fails safe whatever the data; the constraint stops the data going wrong. If validation finds a bad row, the migration fails loudly rather than skip it. |
| D5 | **No permission cache.** Grants keep loading per request, inside the session lookup's transaction. docs/08 §4's cache sentence is corrected. | **As written.** A cache would add an invalidation path to get wrong, for a lookup that is already one indexed query in a transaction the request opens anyway. Revisit with measurements, not by default. |
| D6 | **A static guard keeps it in one place.** A unit test, on the API's TypeScript program with the real types, fails if code outside the allowlist reads an `Actor`'s `grants` or a `Grant`'s `scopeType`/`scopeId`. Allowlist: `policy.ts` (decides), `session.service.ts` (builds grants), `actor.ts` (the `Actor`/`Grant` types, and `needsMfa`/`sessionClassFor`, which classify a session rather than decide access). | **As written,** with its limits stated: like spec 0015's CI10 it sees typed property access, not values laundered through `any` or casts. The negative tests below don't depend on it. |

## Acceptance criteria

| ID  | Criterion |
| --- | --------- |
| PS1 | _One decision point._ `AccessGuard` (through `enforcePermission`), `SettingsService.canManage` and `/auth/me`'s permission list all go through `PolicyService`. `canInstitutionWide` is removed. Unit tests on each caller show it asks the policy (a policy that denies everything makes each refuse or list nothing). |
| PS2 | _Behaviour unchanged._ Every existing identity, step-up, MFA, settings, files and route-sweep test passes **unmodified**. The OpenAPI document is byte-identical (`pnpm contracts:gen` produces no diff). |
| PS3 | _The matrix (unit)._ For **every** permission in the catalog × every scope type (`INSTITUTION`, `ORG_UNIT`, `PROGRAMME`, `COHORT`, `COURSE_OFFERING`, `HOSTEL`) × MFA present/absent × step-up fresh/stale/absent/in the future: `evaluate()` against the institution context allows **only** for an `INSTITUTION` grant with a null `scopeId`, with MFA when the permission is privileged, and a fresh step-up when it's flagged; otherwise it names the first failing reason in D3's order. No permission or scope is left out: the test enumerates the catalog and the Prisma enum, so a new one is covered automatically. |
| PS4 | _Negative coverage end to end (integration, real database)._ For each of the five resource scopes, a user whose only grant of `identity.user.view` is at that scope gets **403** from `GET /api/v1/users`, and `/auth/me` lists no `identity.user.view`. A control user with the institution grant gets 200 and sees it listed. A cross-tenant case: an institution grant in tenant A gives nothing on tenant B's host (401, the session belongs to A). |
| PS5 | _Malformed grants (D4)._ Unit: an `INSTITUTION` grant with a `scopeId`, and a grant with an unknown scope type, allow nothing. Integration: the migration's `CHECK` refuses an `INSTITUTION` assignment with a `scope_id` and a resource-scoped one without, as the app role and the migrator. |
| PS6 | _The type boundary (D2)._ A compile-time test (`// @ts-expect-error`) shows that passing any context other than `{ scope: 'INSTITUTION' }` doesn't type-check. |
| PS7 | _The static guard (D6)._ It passes on the code; fixtures, compiled with the real types, show it reports a direct `actor.grants` read, a destructured `grants`, a `scopeType` comparison on a `Grant`, and each through an alias; and that the allowlisted files pass. |
| PS8 | _Evidence._ Every PS ID appears in a test name. Mutations, each failing its intended test: an `ORG_UNIT` grant accepted institution-wide (PS3, PS4); the `scopeId` check dropped (PS5); MFA not required for a privileged permission (PS3); step-up not required for a flagged permission (PS3); the precedence swapped so `mfa_required` precedes `forbidden` (PS3); `SettingsService` reverting to its own grant check (PS1, PS7); `/auth/me` listing every grant's permission (PS4); the `CHECK` constraint removed (PS5). |

## Design

```ts
// apps/api/src/modules/identity/policy.ts
export type ResourceContext = { readonly scope: 'INSTITUTION' }; // resource scopes add variants (ADR-028)
export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'forbidden' | 'mfa_required' | 'step_up_required' };

/** Pure: the whole rule, matrix-tested (PS3). */
export function evaluate(actor: PolicyActor, permission: Permission, resource: ResourceContext, now: Date): Decision;
/** Pure: the permissions this actor holds for the context (for /auth/me). */
export function permissionsHeld(actor: PolicyActor, resource: ResourceContext): Permission[];

@Injectable()
export class PolicyService {
  can(actor, permission, resource, now = new Date()): boolean;   // evaluate(...).allowed
  decide(actor, permission, resource, now = new Date()): Decision;
  held(actor, resource): Permission[];
}
```

- **`PolicyActor`** is `Pick<Actor, 'grants' | 'mfaAt' | 'stepUpAt'>`: the policy sees nothing else.
- **A grant counts for the institution context** when `scopeType === 'INSTITUTION' && scopeId === null` (D4).
- **`enforcePermission(actor, permission)`** keeps its signature (settings' run-time permissions use it) and becomes a mapping from `decide()` to the existing problem errors. `AccessGuard` keeps its order: authenticate, restricted-session check, then the permission.
- **`SettingsService`** asks `policy.can(actor, def.manage, INSTITUTION)`. **`/auth/me`** returns `policy.held(actor, INSTITUTION)`.
- **The migration** (tenant shard, expand only): `ALTER TABLE role_assignment ADD CONSTRAINT role_assignment_scope_id_matches_type CHECK ((scope_type = 'INSTITUTION') = (scope_id IS NULL)) NOT VALID;` then `VALIDATE CONSTRAINT`. RLS is unchanged.
- **The guard (D6)** reuses the TypeScript program helper behind spec 0017's PB4 guard (`apps/api/src/testing/session-sql-guard.ts`'s `packageProgram`), so it sees exactly what the compiler sees.

## Implementation notes

**Decisions made while implementing, for the owner's approval:**

1. **`holds()` for what to show.** Settings' `canManage` uses the scope rule alone (`policy.holds`), not the full decision: every manage permission is privileged and needs step-up, so the full decision would turn `canManage` false for an admin without a fresh step-up, which isn't today's behaviour (PS2). The write itself is still decided by `evaluate()` (MFA, step-up).
2. **`enforcePermission` calls the pure `evaluate()`** and maps the refusal through one table (`REFUSALS`), with the same responses as before. PS1's check for it is that mapping, tested per reason; `SettingsService` and `/auth/me` get `PolicyService` injected, and a policy holding nothing lists nothing.
3. **`needsMfa` takes the grants' holder** (the actor, or the result of `loadGrants`), so no caller outside the allowlist reads `actor.grants`. It still counts a privileged permission at **any** scope: holding one requires MFA (docs/08 §3.2), while using it is decided by scope. PS4's users therefore enrol MFA first.
4. **The settings check in PS4 uses `files.storageQuotaBytes`** (core, always on, managed by `settings.tenant.manage`): the registration key belongs to a product that may not be active.

**Evidence (local, against the dev stack).**

- Unit: API 319/319, including the matrix (13 permissions × 6 scopes × 2 × 4 = 624 cases, enumerated from the catalog and the Prisma enum), PS5, PS6 and PS1 (`policy.spec.ts`, 8 tests), and the guard (`policy-guard.spec.ts`, 13: the API passes; 9 forms reported; 2 non-reads not reported).
- Integration: `policy.int.spec.ts` with the identity, step-up, MFA and settings suites, unmodified: 113/113 across 5 files. `pnpm contracts:gen` produced no diff; `pnpm rls:check` passes.
- **PS8 mutations, each failing its intended test:** `ORG_UNIT` accepted institution-wide (PS3, PS4, PS1); the `scopeId` check dropped (PS5); MFA not required (PS3, PS1); step-up not required (PS3, PS1); `mfa_required` before `forbidden` (PS3); settings' own grant check (PS4 for every scope, PS7); `/auth/me` listing every grant (PS1, PS4, PS7); the CHECK constraint dropped (PS5).

## Affected docs (in the implementation PR)

- **[08](../08-security.md) §4:** `PolicyService` as built (D1–D3); the per-session cache sentence replaced by D5.
- **[03](../03-domain-model.md):** the `role_assignment` scope constraint (D4).
- **[18](../18-roadmap.md):** the identity line: `PolicyService` ✅ and the negative tests ✅; resource scopes still ⏸. Also the stale "PgBouncer ❌ not added" in the tooling row, which spec 0017 made out of date.
- **[19](../19-decision-log.md):** ADR-028's consequences: the remaining work done, with this spec's evidence.
- **[12](../12-testing-strategy.md):** the authorization matrix in the unit layer's evidence.

## Out of scope

- **Resource scopes** (`ORG_UNIT` containment by `OrgUnit.path`, programme, cohort, course offering, hostel): with their first consuming modules (ADR-028).
- **Separation of duties** (docs/08 §4): enforced in the use cases that need it; there is no role-assignment endpoint yet.
- **Object-level checks** for students' own records: always derived from the session (docs/08 §4), unchanged.
- **A permission cache** (D5).
