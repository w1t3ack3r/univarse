# Spec 0007 — Tenant settings: one typed key, end to end

**Status:** Draft (2026-10-05). D1–D3 open · **Phase:** 0 (roadmap: "settings module with typed keys") · Implements [02 §11](../02-architecture.md) and invariant 4 ("institution differences are settings").
Every AC ID appears in at least one test name.

## Why
Every `[CONFIG]` rule in [04](../04-business-rules.md) must become a tenant setting before Phase 1 modules can read it. The `setting` table exists (with RLS, and covered by the isolation sweep), but nothing reads or writes it.

This spec builds the whole path for **one** real key: the typed key, validation, the default, authorised update, the audit event, the cache with cross-instance freshness, and a working UI. Later keys then only add a registry entry and, if needed, a page.

Settings are tenant security, not just configuration. A cached value served to the wrong tenant, or a stale value served after a change, is an isolation failure. The OWASP Multi-Tenant Security Cheat Sheet treats cache key isolation and invalidation as part of tenant isolation, so the cache gets its own acceptance criteria.

## Terms
- **Key:** a registered setting name, e.g. `registration.unitLimits`. Only registered keys exist.
- **Registry:** the code-side list of keys in `packages/contracts`. Each entry has a zod schema, a default, its allowed scopes, its owning product, the permission that manages it, and whether it is effective-dated.
- **Override:** a stored row that replaces the default for a tenant (and, later, for a faculty or programme).
- **Effective value:** the override if there is one, otherwise the default.
- **Freshness window:** the longest time, after a change commits, that any API instance may still serve the old value.

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| ST1 | *Typed registry.* Keys are defined only in the registry (`packages/contracts/src/settings.ts`), with a zod schema, default, allowed scopes, owning product, manage permission and `effectiveDated` flag. The API and the web form use the **same** schema. An unregistered key is `404 settings.unknown_key` on every endpoint. A stored row whose key isn't registered is ignored by reads and reported by a check. |
| ST2 | *Default.* With no override, reads return the registry default with `source: "default"`. Reading never writes a row. |
| ST3 | *Validated value.* A write is validated server-side against the key's schema and refused with `422 settings.invalid_value` and field-level errors when invalid. For the first key: whole numbers, 1 ≤ min ≤ max ≤ 60. A stored value that no longer validates (for example after a schema change) is **never** silently replaced by the default: the read fails closed with `500 settings.stored_value_invalid` and an error log naming the tenant and key (not the value). Schema changes ship with a data migration (invariant 9). |
| ST4 | *Authorised update.* Writing needs the key's manage permission. For the first key that is `settings.tenant.manage` (privileged, so MFA is required, plus step-up). Without the permission the answer is `403`. Without a recent step-up it is `428 auth.step_up_required` (the existing flow). A key owned by a product the tenant doesn't have active is `404` (spec 0003). |
| ST5 | *Read permission.* A new permission, `settings.tenant.view`, granted to INSTITUTION_ADMIN and REGISTRAR, allows reading. Listing returns only keys the user may view, of active products. |
| ST6 | *Concurrency (docs/06 §ETag).* Reads return `ETag: "v{version}"`. A write or reset **must** send `If-Match`: missing → `428 precondition.required`; stale → `412 precondition.failed`, with nothing changed. This is the first resource to use the convention, and the helper is shared for later ones. |
| ST7 | *Reset.* Resetting to the default removes the override (same permission, step-up and `If-Match` rules). Afterwards the effective value is the default, with `source: "default"`. |
| ST8 | *Audit (invariants 6, 12).* Every update and reset writes `settings.updated` or `settings.reset` **in the same transaction**, recording the key, scope, previous and new value, and new version. If the audit write fails, the change rolls back. The registry can mark a key `sensitive`, in which case values are redacted in audit. |
| ST9 | *Tenant isolation.* Rows are tenant-scoped under forced RLS (the table is already in the sweep). Through the API, tenant B's host never returns or changes tenant A's value, even for the same key. Admin of A on B's host → `401`/`404` per the existing rules. |
| ST10 | *Tenant-scoped cache keys.* Each API instance may cache effective values in memory under `settings:{tenantId}:{scopeKey}:{key}`. A test proves that two tenants with different overrides of the same key never see each other's value through the cache, and that A's change never evicts or alters B's entry. |
| ST11 | *Cross-instance freshness.* After a change commits, an invalidation `{tenantId, key, scopeKey, version}` is published on Valkey. Every instance evicts that entry. Tests with **two API instances** prove the following. **(a)** An update through instance 1 is served by instance 2 within **2 s**. **(b)** With instance 2's subscription down (message lost), it is served within the cache **TTL (30 s; shortened in the test)**. **(c)** A read that started before the change, and finished after the invalidation, does not re-cache the old value (a per-entry generation check). **(d)** If Valkey is down, reads still work from the DB, and writes still commit. |
| ST12 | *Consumer contract (ADR-020).* Other products read settings only through Core's `SettingsService.get(tenant, key)`, which returns the typed effective value. They never read the `setting` table. |
| ST13 | *Working UI.* An INSTITUTION_ADMIN finds **Settings → Course registration** in the workspace nav (permission-driven). The page shows the current min/max units, whether each is the default, and who changed it last and when. Editing validates on the client with the shared schema and explains errors in plain words. Save asks "confirm it's you" when step-up is needed. A `412` shows "someone else changed this; here are the latest values". Reset to default needs a confirmation. Holders of `settings.tenant.view` only see the page read-only. The UI is designed with the impeccable skill, passes axe, and has E2E coverage on desktop and mobile. |

## Design notes
- **Registry entry (first key), D1:**
  ```ts
  'registration.unitLimits': {
    schema: z.object({ min: z.int().min(1).max(60), max: z.int().min(1).max(60) }).refine((v) => v.min <= v.max),
    default: { min: 15, max: 24 },            // docs/04 §5
    scopes: ['INSTITUTION'],                  // faculty/programme overrides: later (see Out of scope)
    product: 'academics',
    manage: 'settings.tenant.manage',
    effectiveDated: false,                    // applied at registration time, inside the window
  }
  ```
  docs/02 lists `registration.maxUnitsPerSemester`. One object key keeps the `min ≤ max` rule in one schema, and docs/02 is updated to match.
- **Storage:** the existing `setting` row (`tenant_id, key, scope_key, value jsonb, version, updated_by`). `version` increments on every write and drives the ETag. Nothing about the schema changes for this key. The `effectiveFrom` column described in docs/03 arrives with the first effective-dated key.
- **API (core product):**
  - `GET /api/v1/settings` lists the keys the user can see.
  - `GET /api/v1/settings/{key}` returns `{ key, value, default, source, version, updatedAt, updatedBy }`.
  - `PUT /api/v1/settings/{key}` takes `{ value }` and requires `If-Match`.
  - `DELETE /api/v1/settings/{key}` resets to the default and requires `If-Match`.
- **Cache:** an in-process map holding entry, version, generation and expiry. Valkey pub/sub channel `uv:settings:invalidate`, published after commit. Subscribers evict, then bump the entry's generation. A load records the generation before reading the DB and caches only if it is unchanged. TTL 30 s bounds a lost message. Valkey is trusted infrastructure, and messages carry no values.
- **Reuse:** the same invalidation bus closes two tracked gaps later: cross-instance product/tenant cache invalidation (spec 0003 P7) and broadcasting a key "forget" on crypto-shredding (spec 0006, destruction boundary). Both are listed below, not built here.

## Decisions
- **D1: the first key.** Recommended: `registration.unitLimits` (docs/04 §5). It has real validation, needs no effective date, and has a clear owner.
  - **Alternative:** `results.repeatPolicy`, which already has a consumer in `packages/domain`. It changes how results are computed, so it needs effective dating ("from session X") and step-up, and its consumer (the results module) doesn't exist yet. Better as the second slice, with effective dating.
- **D2: freshness.** Recommended: ≤ 2 s through pub/sub, and ≤ 30 s worst case (TTL). Tighter TTLs cost more DB reads, and settings change rarely.
- **D3: who manages.** Recommended: INSTITUTION_ADMIN manages, and REGISTRAR views (the seeded roles today). Letting the Registrar manage registration keys means a per-key permission (`settings.registration.manage`), which the registry already supports. That is a small change if you prefer it.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Faculty/programme overrides and the resolution chain (programme → faculty → institution → default) | The registration module (Phase 1), its first real need |
| Effective-dated keys (`effectiveFrom`, "applies from session X") | The second key (`results.repeatPolicy`) with the results module |
| Settings change history page (the audit log already holds it) | With the audit-log viewer |
| Product/tenant caches on the same invalidation bus (spec 0003 P7) | Before multi-instance production |
| Key "forget" broadcast on crypto-shredding (spec 0006) | Follow-up to this spec, on the same bus |
| Platform-managed feature flags (`feature.*`) | With the console (Phase 1) |
