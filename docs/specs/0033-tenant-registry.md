# Spec 0033: Phase 1's S4, the tenant registry

**Status:** **Draft, for the owner's approval** (Q1 to Q17). Nothing is built from it until it's approved.
**Phase:** 1, slice **S4** of [spec 0025](0025-phase-1-control-plane.md) (E7, E26, and spec 0003's platform side).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A2 (the console has no tenant database credentials), A5 (a slice adds its own `platform.*` permissions), A10 (custom domains wait for hosting), E7 and E26;
- [spec 0003](0003-product-entitlements.md): entitled and enabled, and P9's "only platform code writes `entitled`";
- [spec 0015](0015-cache-isolation.md) and [spec 0016](0016-platform-cache-invalidation.md): a change to the tenant tables reaches every instance through the database triggers;
- [spec 0028](0028-console-identity.md) and [spec 0031](0031-seeing-what-happened.md): the console's sign-in, step-up, audit, and the audit log this slice's changes appear in;
- [05 §1](../05-modules-and-features.md), [06](../06-api-guidelines.md) (cursors, ETags), [11 §9](../11-frontend-guidelines.md) (the console's UI rules), and [08](../08-security.md) T12 and T26.

## Why

UniVarse has three seeded institutions and no way to see or change any of them without a database client. S5 (provisioning) needs somewhere to put the institutions it creates, S6 needs something to suspend, and S10 needs something to attach a plan to. This slice is the console's first real power over institutions, so it decides how that power is limited.

## What exists today, and what the code showed

- **The console role can read three columns of `tenant`** (`id`, `slug`, `short_name`), for the audit log. It can't read anything else about an institution, or write any of it.
- **Entitlements are written only by the seed.** `tenant_product` already has the checks spec 0003 asked for: the product must be in the catalogue, and `enabled` requires `entitled`.
- **Changes already propagate.** `tenant`, `tenant_domain` and `tenant_product` have `SECURITY DEFINER` triggers that queue a cache invalidation, so the console's role needs no extra privilege for them, and a change reaches every instance within the existing bound.
- **`shard.secret_ref` and `tenant_data_key.wrapped_dek` are in tables this slice reads.** Grants are by column, so neither can be selected at all (Q3).
- **Spec 0025 says the logo goes "through the files module". It can't.** The files module is tenant-side: its rows are in the tenant database, behind a tenant session. A2 gives the console no tenant credentials, and that's the boundary worth keeping (Q9).
- **Nothing shows branding yet.** The public profile returns names and a type; the web app's colours are fixed.

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **New permissions, in `packages/domain` as A5 says:**<br>• `platform.tenant.read`: OWNER, SUPER_ADMIN, SUPPORT, FINANCE, READ_ONLY;<br>• `platform.tenant.edit` (profile, regulatory profile, branding): OWNER, SUPER_ADMIN, with step-up;<br>• `platform.tenant.entitlements` (grant or revoke a product): OWNER, SUPER_ADMIN, with step-up. | Support and finance need to look institutions up, and nothing here is anyone's personal data. Changing an institution is a smaller group, and always asks for the authenticator. |
| Q2 | **The list:** `GET /api/platform/v1/tenants`, ordered by legal name then id, 50 a page (at most 200), an opaque cursor. Filters: status and type. | docs/06. Keyset paging stays stable while institutions are being added. |
| Q3 | **Column-level grants only.** The console role gets the columns it shows, and **never** `shard.secret_ref`, `tenant_domain.verification_token`, or `tenant_data_key.wrapped_dek`. A test asserts those three can't be selected. | Even a compromised console can't read a wrapped key. The database refuses, not the code. |
| Q4 | **The detail page:** status, tier, shard (name, kind, region), domains, products, and data keys (version, status, dates), all read-only except what Q5 to Q10 allow. It links to the audit log and the security page filtered to this institution. | It's one place to answer "what's the state of this institution?", reusing S3's filters. |
| Q5 | **Editing the profile:** legal name, short name and ownership. `PUT` with `If-Match` on the row's `version`; a stale page gets 412 and reloads. **The slug never changes:** it's the subdomain. | docs/06's rule for multi-field edits, so two staff can't silently overwrite each other. |
| Q6 | **The type can change only before an institution is ACTIVE** (REQUESTED, PROVISIONING, ONBOARDING). After that the field is read-only. | The type picks the regulator now, and the grading scheme and carry-over rules from S5's templates. Changing it under live results isn't an edit, it's a migration. |
| Q7 | **The regulatory profile (E7), in its own table:** the regulator is **derived from the type** (university: NUC; polytechnic: NBTE; college of education: NCCE), as a pure function. Staff enter the operating status (`APPROVED`, `PROVISIONAL_LICENCE`, `SUSPENDED_BY_REGULATOR`, `UNKNOWN`), the state (36 states and the FCT), the regulator's reference, and the JAMB institution code. | The regulator can't disagree with the type. **`[VERIFY]` with a registrar before anyone relies on them:** the status list, and the JAMB code's format, so it's stored as checked text (up to 16 letters and digits), and nothing depends on it yet. |
| Q8 | **Global search (E26):** one box in the console's header, for anyone with `platform.tenant.read`. It matches legal name, short name, slug and hostname, case-insensitively, from 2 characters, and opens the list filtered. `%` and `_` are escaped. Tickets and provisioning runs join when they exist. | E26. A plain `ILIKE` is enough for hundreds of institutions. Its trigger for a trigram index: 1,000 institutions. |
| Q9 | **The logo is stored in the platform database, not the files module.** A row in `tenant_branding`: PNG or WebP, at most 256 KB and 1024 × 1024, checked from the file's own header. **SVG is refused,** because it can carry script. This corrects spec 0025's S4 row. | Going through the files module would need tenant credentials in the console, or a job for one small image. A logo is public by nature, small, and needed before anyone signs in. Alternative: a platform bucket, with new storage credentials for the platform API. Rejected for one file per institution. |
| Q10 | **Colours:** one primary colour, as `#RRGGBB`, checked in `packages/domain`: it needs 4.5:1 against white or against the deep brand ink, and the page picks the text colour that passes. A colour that can't reach 4.5:1 with either is refused, and the form says why. | WCAG 2.2 AA holds by construction, whatever an institution picks. One colour, because every extra one multiplies what must be checked. |
| Q11 | **Where branding shows:** the logo on the sign-in pages and the workspace rail, and the primary colour on the rail and primary buttons. `GET /api/v1/tenant/logo` is public, `@Product('core')`, sent with the hash as an ETag, `nosniff`, and a fixed image type. An institution with no logo sees its name, as today. | The tenant comes from the Host, so one institution can never ask for another's. A logo is shown to people who haven't signed in. |
| Q12 | **`tenant_branding` joins the cache triggers** (a tenth trigger, and `rls:check` counts it). The logo's bytes aren't in the tenant cache, only its hash; the image itself is cached per institution for the same bound. | The same mechanism as every other tenant table. Otherwise a public route reads the platform database on every page load. |
| Q13 | **Granting or revoking a product (spec 0003 P9):** one route per product, step-up, and **a reason is required**, kept in the audit metadata. `core` can't be changed. Revoking also switches it off, in one statement, as the database's check requires. Platform audit and the change commit together, in one transaction. | S10's plans will drive this later; until then a person does, so the reason is the record of why. |
| Q14 | **Revoking asks for typed confirmation:** the institution's slug, per 11 §9. Granting doesn't. It's **not** a two-person action: revoking hides a product and deletes nothing, and granting it back restores it. | Typed confirmation stops the wrong-row slip. A7's two people are for what can't be undone. |
| Q15 | **Nothing else changes state here.** Suspend and resume are S6, offboarding and purge S7, creating an institution S5, and custom domains wait for hosting (A10). | Each has its own approvals and warnings. The list shows the status; it doesn't change it. |
| Q16 | **What's audited:** every change, in the same transaction, with before and after for the fields changed, and the logo's hash, not its bytes. **Reading is not audited:** the list and detail hold no personal data (S3's Q8 rule). The institution's own IT Admin sees a product change through their products page. | Invariants 6 and 12. Actions: `platform.tenant.profile_changed`, `.regulatory_changed`, `.branding_changed`, `.product_granted`, `.product_revoked`, labelled for S3's log. |
| Q17 | **Three PRs, one release.** **A:** the migration and grants, domain, the routes, integration tests. **B:** the console's screens and search, and their E2E. **C:** the logo route and branding in the web app, and its E2E. Then the release and the deploy. | Each is reviewable alone, and C is the only one that touches the tenant side. |

## New threat

| # | Threat | Attack | Controls |
| --- | --- | --- | --- |
| T32 | **A hostile logo** | A staff account or a bad upload stores a file that runs as script on every institution's public page | PNG and WebP only, checked from the file's own bytes; SVG refused; size and dimension limits; served from the tenant's own host with `nosniff` and a fixed type, never the stored name; step-up and audit on every change |

T26 (a platform insider changing entitlements) gets S4's controls added: the permission, step-up, a required reason, and the audit log.

## Acceptance criteria

1. **Who sees what:** each role's access matches Q1, by route; a member without the permission gets 404-by-absence on the screens and is refused by the API.
2. **The grants:** `shard.secret_ref`, `tenant_domain.verification_token` and `tenant_data_key.wrapped_dek` can't be selected by the console role, and no response contains them.
3. **The list** pages stably, filters, and refuses an unknown parameter.
4. **Search** finds by legal name, short name, slug and hostname; a `%` matches only a literal `%`.
5. **The profile:** a stale `If-Match` gets 412; the slug can't be changed by any route; the type changes only before ACTIVE.
6. **The regulator** can't disagree with the type.
7. **Branding:** an SVG, a renamed file, an oversized file and a too-large image are refused; a colour without 4.5:1 is refused.
8. **The logo route** serves only this host's institution, with `nosniff` and a fixed type, and answers 304 on a matching ETag.
9. **Granting and revoking:** step-up and a reason are required; `core` is refused; **a revoked product's routes 404 for that institution within the cache bound**, and its jobs are held; granting it back restores it.
10. **Audit:** every change, in the same transaction, in S3's log with plain words; no logo bytes in it.
11. **An unauthorized and a wrong-institution case** for every write route.
12. **The E2E:** an OWNER finds an institution by search, edits it, sets a logo and colour, revokes and grants a product; READ_ONLY sees and changes nothing; desktop and phone, with axe.
13. **Mutation checks** on each control above.
14. **Released and deployed;** the owner edits a seeded institution on the stack and sees its logo on that institution's sign-in page.

## The owner's steps

- Approve or change Q1 to Q17.
- Check Q7's `[VERIFY]` items with a registrar when you can. It doesn't block the build.
- After the PRs: the release and the deploy, then the check in criterion 14.

## Affected docs

In this PR: [18](../18-roadmap.md). In the implementation PRs: [03](../03-domain-model.md) (`TenantRegulatoryProfile`, `TenantBranding`), [06](../06-api-guidelines.md), [07](../07-data-and-database.md) (grants, the tenth trigger), [08](../08-security.md) (T32, T26), [spec 0025](0025-phase-1-control-plane.md)'s S4 row (Q9's correction).

## Out of scope

- **Creating an institution:** S5. **Suspending, resuming:** S6. **Offboarding, purge:** S7. **Plans driving entitlements:** S10.
- **Custom domains:** A10, until there's hosting.
- **An institution's own branding screen:** its IT Admin edits this from Phase 2 (05 §2). This slice builds the store they'll share.
- **Letterheads and document branding:** with the documents that use them.
- **Per-tenant feature flags and release rings:** S6 (E18).
