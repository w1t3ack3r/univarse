# Product

<!-- impeccable:product-schema 1 -->

Scope: the platform console (`apps/console`), UniVarse's own tool for running the platform, on its own host behind an allowlist. The tenant web app (`apps/web`) has its own record. The full blueprint is in `docs/` (start at `docs/01-product-brief.md`; the console's specs are 0025, 0027, 0028, 0031 and 0033). This file keeps only what design work must honour.

## Platform

web

## Users

UniVarse's own staff, never an institution's (confirmed by the owner, 2026-11-11). Each has one of five roles, and every screen follows what that role may do (`packages/domain/src/platform/permissions.ts`):

- **OWNER:** runs the platform. The only role that manages staff and attests the monthly access review.
- **SUPER_ADMIN:** runs institutions day to day (their profile, branding and products) and reads staff, the audit log, security events and the access review.
- **SUPPORT:** answers institutions' IT Admins (the last link in the support chain user → IT Admin → UniVarse). Today it reads the institutions; it never sees the audit log or security events.
- **FINANCE:** will run plans, subscriptions and invoices (billing is Phase 1b, S10). Today it reads the institutions; it never sees the audit log or security events.
- **READ_ONLY:** reads staff, the audit log, security events, the access review and the institutions; never starts or changes anything.

**Desktop first, the phone works** (confirmed, 2026-11-11): most of the work happens at a desk, with dense tables, the audit log and the registry. The phone is for urgent moments: an approval, a suspension, a security event. Every screen must still work at 360 px.

## Product Purpose

The console is where the platform is run: institutions are registered, configured and moved through their lifecycle; products are entitled; staff are invited and reviewed; what happened is read from the platform's hash-chained audit log. It replaces the owner's terminal and the seed for that work, with the same discipline as the rest of UniVarse: every action permissioned, step-up where it matters, audited in the same transaction, and destructive actions behind two people.

Success: a staff member does the job right the first time, can see exactly what they're about to change and for whom, and every change is attributable afterwards.

## Positioning

The console is the platform's highest-value target (threat T12): whoever controls it controls every institution. So it is built as a separate place, not an admin area of the tenant app: its own host, API process, database role (with no access to any tenant's database), cookie, CSP and signed image (spec 0027). **There is no "log in as user"** (spec 0025 E5); the console never reads tenant personal data.

## Operating Context

- **Hosts:** `console.univarse.localhost:4180` in development, `console.stack.univarse.localhost` on the local stack. Outside the allowlist the console answers 404, as an unknown address does.
- **Environment banner on every page:** LOCAL, STAGING or PRODUCTION, from `UNIVARSE_ENVIRONMENT`; anything unknown shows as LOCAL, never PRODUCTION.
- **Sign-in:** the first OWNER only through a CLI command the owner runs; everyone else invited by an OWNER, activated with an emailed code. An authenticator app is mandatory before anything else. Sessions end after 15 min idle and 8 h at most, at most 3 per member. Sensitive actions ask for step-up (5 minutes).
- **Institutions are data here, not hosts:** the console shows an institution's name, slug, status, colour and logo as facts and previews, never as its own theme.

## Capabilities and Constraints

- **Built:** S1 the shell and its walls (spec 0027); S2 identity: activation, sign-in, authenticator and recovery codes, sessions, staff (spec 0028); S3 the audit log with chain verification, security events, the monthly access review (spec 0031); S4 the tenant registry: institutions, their facts, products and branding (spec 0033); S5 provisioning and go-live (spec 0034); S6's two-person approvals and the inbox (spec 0037 PR A).
- **Next** (spec 0025): the rest of S6 (suspension, notices and their delivery log, release rings, incidents), then S7 and S8; Phase 1b adds S9 to S11 (billing is S10; NDPA registers, peak days, operations and keys are S11).
- **Rules for consequential actions** (docs/11 §9): every destructive action needs a typed confirmation (the institution's slug) and a reason, and shows the two-person approval status where one is required. Refusals and out-of-scope resources are 404.
- **Hard constraints:**
  - A stricter CSP than the tenant app: per-request nonce, `connect-src 'self'` only, `noindex` everywhere.
  - Session cookie only (`__Host-uv_console_sid`, `SameSite=Strict`); nothing in browser storage.
  - Problem codes map to fixed messages (`packages/contracts`), never to server `detail`.
  - No mock data, no placeholder sections, no navigation to things that don't exist yet.

## Brand Commitments

- **Identity hierarchy (confirmed 2026-11-11): UniVarse leads.** It is UniVarse's own tool: the deep-green platform bar with the wordmark and the environment banner on every page, so nobody mistakes the console for an institution's workspace. An institution's colour and logo appear only as data.
- **Voice (confirmed 2026-11-11): precise and plain.** Calm, exact and operational: name the institution, the action and its consequence ("Suspend test-poly: its users are signed out"). Glossary terms (`docs/00-glossary.md`) such as institution, slug, product and step-up are fine, because staff know them; nothing beyond the glossary. Never alarming, never cute.
- **UniVarse brand kit:** deep green `#485550`, lime `#C0EB6A`, off-white `#F4F6F0`, white; Poppins. Assets in `public/brand/` (SVG); the source kit in `docs/brand-doc/` is not committed.
- **Binding rule:** lime is never text, an icon or a focus ring on a light surface (1.37:1).

## Evidence on Hand

- The brand kit and the shared components in `packages/ui` (with Storybook, every story axe-tested).
- The seeded institutions `demo-uni` and `test-poly`, and drill tenants on the stack. No real institutions, customers or usage numbers exist yet. Don't invent any.

## Product Principles

1. **Know what you're touching.** Every consequential screen names the institution, the action and the consequence before anything is changed.
2. **Friction where it matters, and nowhere else.** Typed confirmation, a reason, step-up and a second person are for destructive and sensitive actions; reading and routine work stay fast.
3. **Everything is attributable.** What changed, who changed it and why is recorded, and the console shows it.
4. **The console is not a tenant.** It looks and behaves like UniVarse's own place; it never borrows an institution's identity or reads its people's data.
5. **Real or nothing.** No mock data and no placeholder screens: a feature appears when it works.

## Accessibility & Inclusion

WCAG 2.2 AA, measured: axe has no serious or critical findings in the console's E2E, desktop and phone. Keyboard-complete, visible focus, targets ≥ 24 px (48 px preferred), errors linked to their fields, no sideways scroll at 360 px, `prefers-reduced-motion` respected. Status never relies on colour alone; charts pass the colour-blind checks and carry labels.
