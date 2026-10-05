# Product

<!-- impeccable:product-schema 1 -->

Scope: the tenant-facing web app (`apps/web`), served on each institution's own address. The platform console (`apps/console`) is a separate surface with its own record. The full product blueprint is in `docs/` (start at `docs/01-product-brief.md`); this file keeps only what design work must honour.

## Platform

web

## Users

People of one Nigerian tertiary institution, signing in on that institution's own address:
- **Students and applicants.** The majority. Mostly on low-end Android phones over weak or metered mobile data. Often first-years with little patience for jargon.
- **Staff:** lecturers, HODs, deans, Registry, bursary, admissions, student affairs. They work in one workspace whose navigation follows their permissions. They mix desktop (offices, labs) and phone.
- **The institution's IT Admin**, who switches products on, manages users and is the first line of support.

The sign-in surfaces serve all of them, at moments that matter: first activation, a forgotten password, setting up two-step sign-in, or confirming identity before a sensitive action (publishing results, changing roles).

## Product Purpose

UniVarse is the operating platform for Nigerian tertiary institutions. One multi-tenant system covers admissions, fees, registration, teaching and CA, results, student affairs and transcripts. Institutions adopt it instead of building or stitching vendors together. Success means a student can do everything from a phone on a weak network, and every consequential action is logged and attributable.

## Positioning

**Integrity is built in, not bolted on:** one identity and one record per student, a hash-chained audit log, immutable published results, step-up re-authentication for sensitive actions, and products an institution switches on independently. Confidentiality, integrity and availability are the first design constraint (docs/01 §1.1).

## Operating Context

- **Each institution has its own address** (e.g. `demo-uni.univarse.ng`), and the tenant is resolved from it. Institutions differ by settings, never by forked code.
- **Peaks are real:** result release (10k concurrent), course registration, 2,000 students starting a CA test in the same minute.
- **Support chain:** user → institution IT Admin → UniVarse. Error screens carry a support reference.
- **Sign-in facts:**
  - Accounts are activated with an emailed 6-digit code; there are no default passwords.
  - Staff with approval powers must use an authenticator app, with one-time recovery codes.
  - Sensitive actions ask the person to confirm their identity again (step-up, 5-minute window).

## Capabilities and Constraints

- **Built so far:** login, MFA verify (authenticator or recovery code), logout, and a workspace whose navigation is built from permissions and the institution's active products.
- **Specified next (spec 0005 PR B):** activation, password reset, MFA enrolment (QR + recovery codes shown once), and a step-up dialog.
- **Tenant branding overrides** (institution logo/crest, colour) arrive in Phase 1. Until then the institution is identified by its name only. Do not fake a crest.
- **Hard constraints:**
  - Session cookie only; nothing in browser storage.
  - CSP with a per-request nonce; no third-party scripts or fonts.
  - Problem codes map to fixed messages (`packages/contracts`), never to server `detail`.
- **Performance budget:** ≤ 170 KB JS per student route, LCP ≤ 2.5 s on low-end Android over slow 4G (docs/11 §5).

## Brand Commitments

- **Identity hierarchy (confirmed 2026-10-05): the institution leads.** On a tenant's address the institution's name is the hero. UniVarse is present but small, as a trust mark (e.g. "Secured by UniVarse").
- **Voice (confirmed 2026-10-05): warm and plain.** Short, friendly, plain English a first-year can follow on a phone ("Check your email for a 6-digit code"). Calm about security, never alarming. No jargon ("MFA", "TOTP", "tenant") in user-facing copy.
- **UniVarse brand kit:** deep green `#485550`, lime `#C0EB6A`, off-white `#F4F6F0`, white. Typeface Poppins. Logo: the slanted "U" that is also a closed book with pages. Assets: `public/brand/` (SVG), source kit in `docs/brand-doc/` (not committed).
- **Binding rule:** lime is never text, an icon or a focus ring on a light surface (1.37:1). Measured contrasts are in spec 0005.

## Evidence on Hand

- Brand kit (logos, palette, mockups) and a Figma landing page for the marketing site.
- No institution crests, customer logos, testimonials or usage numbers exist. Don't invent any.

## Product Principles

1. **Trust is felt, not announced.** Security steps should feel calm, competent and brief; the integrity story shows in reliability, not warnings.
2. **The institution is the host; UniVarse is the infrastructure.**
3. **Phone-first, data-light.** Every screen must work on a cheap Android phone on a weak, metered connection.
4. **Plain words, one next step.** Every screen says what happened and what to do next; every error carries a support reference.
5. **Same truth everywhere.** One workspace, one identity; what you see follows what you are allowed to do.

## Accessibility & Inclusion

WCAG 2.2 AA, measured. Keyboard-complete. Visible focus. Targets ≥ 24 px (44 px preferred on touch). Errors linked to their fields. Respect `prefers-reduced-motion`. Names support single names, hyphens, apostrophes and diacritics (docs/11 §8). axe has no serious or critical findings in E2E.
