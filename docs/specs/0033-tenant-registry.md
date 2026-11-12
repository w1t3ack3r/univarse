# Spec 0033: Phase 1's S4, the tenant registry

**Status:** **Done (2026-11-11).** Approved by the owner on 2026-11-09, all as written: Q1 to Q17, Q-A1 to Q-A7 and Q-B1 to Q-B6; Q-C1 to Q-C5 approved on 2026-11-11. All three PRs merged (#164, #165, #167), released as `3b14a76` and deployed; the owner's check in criterion 14 passed on the stack.
**Phase:** 1, slice **S4** of [spec 0025](0025-phase-1-control-plane.md) (E7, E26, and spec 0003's platform side).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A2 (the console has no tenant database credentials), A5 (a slice adds its own `platform.*` permissions), A10 (custom domains wait for hosting), E7 and E26;
- [spec 0003](0003-product-entitlements.md): entitled and enabled, and P9's "only platform code writes `entitled`";
- [spec 0015](0015-cache-isolation.md) and [spec 0016](0016-platform-invalidation-outbox.md): a change to the tenant tables reaches every instance through the database triggers;
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

1. **Who sees what:** each role's access matches Q1, by route; a member without the permission sees no tab and a not-found page, and the API refuses them.
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
- ~~After the PRs: the release and the deploy, then the check in criterion 14.~~ Done on 2026-11-11: released as `3b14a76`, deployed, and the owner saw an institution's colour and logo on its own sign-in page and not on another's.

## Affected docs

In this PR: [18](../18-roadmap.md). In the implementation PRs: [03](../03-domain-model.md) (`TenantRegulatoryProfile`, `TenantBranding`), [06](../06-api-guidelines.md), [07](../07-data-and-database.md) (grants, the tenth trigger), [08](../08-security.md) (T32, T26), [spec 0025](0025-phase-1-control-plane.md)'s S4 row (Q9's correction).

## Out of scope

- **Creating an institution:** S5. **Suspending, resuming:** S6. **Offboarding, purge:** S7. **Plans driving entitlements:** S10.
- **Custom domains:** A10, until there's hosting.
- **An institution's own branding screen:** its IT Admin edits this from Phase 2 (05 §2). This slice builds the store they'll share.
- **Letterheads and document branding:** with the documents that use them.
- **Per-tenant feature flags and release rings:** S6 (E18).

## PR A: what was built

The migration and grants, `packages/domain/src/platform/tenant-registry.ts`, and the routes in `apps/api/src/platform/registry/`.

**Found while building:**
- **The seed was going to undo the console's work.** It runs on every deploy, and it reset each seeded institution's entitlements to the seed's plan. Once staff can grant and revoke, a deploy would have silently reversed them. The seed now only creates a missing row.
- **`platform_audit_event.tenant_id` was always null** from the console's own actions, because nothing had needed it. It's now set for these, so S3's log can be filtered to an institution (Q4).

**Decisions made while building PR A, approved by the owner on 2026-11-09:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **The seed creates a missing entitlement and never changes one.** | As above. Spec 0003's "re-seeding resets the plan" is retired. |
| Q-A2 | **An archived or purged institution can't be changed,** by any route, with `409 tenant.closed`. | There's nothing left to describe. Suspended and offboarding ones can still be edited: their names may still need correcting. |
| Q-A3 | **Lacking the permission answers 404, as every platform route does.** | Q1's "refused". The platform guard's rule from spec 0028: out of scope reads as absent. |
| Q-A4 | **The logo is sent as base64 in JSON,** at most 360,000 characters, and the console previews it from `GET /tenants/{id}/branding/logo`. | It keeps the one body parser, the CSRF check and strict validation. A raw upload would add a second way in for one small file. |
| Q-A5 | **The colour and the logo take no `If-Match`.** Each is one absolute value, and the audit log shows both writers. | As spec 0003 decided for a switch. `If-Match` is for multi-field edits, where a change can be lost silently. |
| Q-A6 | **The database refuses a bad logo or colour too:** a `CHECK` on the hex format, the type, the hash and the size. | The same limits as the application, so a bug there can't store something else. |
| Q-A7 | **The reason for a grant or revocation is free text, kept in the audit metadata (Q13), 5 to 500 characters.** Staff shouldn't put a person's details in it, and the console will say so in PR B. | The audit log's other fields hold ids only. This one can't be checked by a machine. |

## PR B: what was built

The console's screens in `apps/console/src/app/institutions/`: the list, the header's search on every page, the detail page, and the forms. S3's audit log and security page now take `?tenantId=`, so an institution links to its own view of them.

**Decisions made while building PR B, approved by the owner on 2026-11-10:**

| # | Decision | Why |
| --- | --- | --- |
| Q-B1 | **What's searched for stays in the address** (`/institutions?q=`). | A result can be reloaded or sent to another staff member, and an institution's name is nobody's personal data (invariant 8 is about people). |
| Q-B2 | **The status and type filters apply as you choose them,** unlike the audit log's Show button. | Listing institutions isn't audited (Q16), so nothing fills up. |
| Q-B3 | **The colour and the logo are checked in the browser first,** with the same `packages/domain` rules the server uses. | A colour nobody can read is explained before anyone is asked for an authenticator code. The server still decides. |
| Q-B4 | **A file that fails the check never leaves the page.** | Slow networks: nobody waits to upload something that will be refused. |
| Q-B5 | **An archived or purged institution shows no forms and no Grant or Revoke,** as if the viewer had no permission to change it. | The API refuses them anyway (Q-A2), so offering them would only produce an error. |
| Q-B6 | **The console's roles are described for what they now do** in the Staff page's hints: SUPPORT and FINANCE can look institutions up. | The old hints said "their own account only". |

## PR C: what was built

Branding in the web app (Q11, Q12, Q17).

- **The API:** the tenant's cached context now carries its colour and its logo's hash, read with the tenant through the existing `tenant_branding` grant, and evicted by its capture trigger. `GET /api/v1/tenant/public-profile` adds `branding: { primaryColor, textColor, logoSha256 }`, with `textColor` from the domain's `textColorOn`. `GET /api/v1/tenant/logo` serves the bytes: the Host's institution only, its checked type, `nosniff`, the sandboxed CSP, the hash as the ETag and 304 on a match; 404 with no logo.
- **The web app:** the logo beside the institution's name on the sign-in pages, on the workspace rail and, on a phone, in the top bar. The colour on the primary buttons and the rail.
- **Tests:** `tenant-logo.int.spec.ts` (no branding, the profile's pair for a dark and a light colour, the bytes and headers, 304, the cache policy, a new logo's new hash, another host and an unknown host); the route sweep; `branding.e2e.ts` (the sign-in page and the workspace, desktop and phone, axe; another institution's page has neither). The E2E writes branding as the migrator, so it runs on the dev chain and the image run, and is skipped on the stack run, which criterion 14 covers.

**Decisions made while building PR C, approved by the owner on 2026-11-11:**

| # | Decision | Why |
| --- | --- | --- |
| Q-C1 | **The logo is the one API response a browser may keep:** asked for under its own hash (`?v=`), a 200 PNG or WebP is `public, max-age=31536000, immutable`. Everything else, this route's 304 and 404 included, stays `no-store`, and the global hook keeps the exception for nothing else. | Otherwise every page load downloads the logo again, up to 256 KB, on slow networks. A new logo has a new hash, so a new URL: a kept copy is never stale. The logo is public and names no one. |
| Q-C2 | **The logo route takes one optional query parameter, `v`, a 64-hex hash;** anything else is the documented 400. A `v` that isn't the current hash is served, but never cached. | The contract's strict-query rule; and a page rendered just before a change still gets a logo. |
| Q-C3 | **The logo's bytes are kept in memory per institution for the tenant cache's bound,** keyed by the hash the context names. | A public page shouldn't read the platform database on every load; a new hash reads again. |
| Q-C4 | **On a branded rail, the text, the muted text and the focus ring all use the one text colour the domain chose;** the hover tint follows whether the colour is dark or light. | UniVarse's muted grey and lime focus ring were checked against deep green only; an institution's colour could be anything that passes Q10. |
| Q-C5 | **On the rail the logo sits on its own small white tile;** on the sign-in page and the phone's top bar, which are already light, it stands on its own. | A logo is drawn for white paper and may not read on the institution's own colour. |

