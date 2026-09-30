# 11 — Frontend Guidelines

Applies to `apps/web` (tenant-facing) and `apps/console` (platform). Shared components live in `packages/ui`.

## 1. App structure (`apps/web/src/app`)

```
app/
├── (public)/                # landing, admissions info, calendar, /verify/[code]
├── (auth)/                  # login, activate, reset-password, mfa
├── apply/                   # applicant portal
├── student/                 # student portal
├── staff/                   # permission-driven workspace
│   ├── layout.tsx           # nav built from the user's effective permissions
│   ├── results/…            # score sheets, approvals, broadsheets
│   ├── registration/…
│   ├── bursary/…
│   ├── admissions/…
│   ├── records/…
│   ├── exams/…
│   ├── graduation/…
│   ├── hostel/…
│   └── admin/…              # institution setup, users, roles, settings, integrations
├── api/                     # NOT used for business APIs (edge routes /api to NestJS)
└── layout.tsx
middleware.ts                # session presence check + redirects, security headers/nonce
```

- **One workspace, permission-driven.** Navigation items declare the permission they need (`requires: 'results.scoresheet.view'`). A page renders only if the user holds the permission in some scope. The API remains the real enforcement point.
- Tenant branding (logo, name, colors) is loaded server-side from `/api/v1/tenant/public-profile` and applied as CSS variables.

## 2. Rendering & data fetching

| Situation | Approach |
|-----------|----------|
| Initial page data | **Server Components** fetch through the generated API client, forwarding the session cookie (`cookies()`), with `cache: 'no-store'` for personal data |
| Interactive lists, mutations | Client Components with **TanStack Query** (via the generated client). `invalidateQueries` after mutations |
| Forms | **react-hook-form + zod** resolvers using the **same schemas** from `packages/contracts` |
| Long jobs | Poll `/jobs/{id}` or SSE. Progress UI |
| Real-time (approval queues, monitoring) | SSE first. WebSockets only if needed |

Rules:
- **No tokens in `localStorage`/`sessionStorage`.** Auth is the HttpOnly cookie only.
- **No mock data in production code paths.** Fixtures live in `*.stories.tsx`, tests or MSW handlers under `__mocks__`, and are never imported by app code (lint rule).
- Error handling maps `problem.code` → user message in `packages/contracts/error-messages.ts`, and always shows `requestId` for support.
- Every mutation button: disabled while pending, idempotency key generated per intent, optimistic UI only where rollback is trivial.

## 3. Design system

- Base: shadcn/ui on Radix, in `packages/ui`. Tailwind v4 with design tokens as CSS variables.
- **Brand tokens** (carried from v0):

| Token | Value | Use |
|-------|-------|-----|
| `--uv-primary` | `#485550` (dark sage) | Primary actions, headers |
| `--uv-accent` | `#C0EB6A` (lime) | Highlights, secondary CTAs (dark text on it) |
| `--uv-surface` | `#F4F6F0` (light sage) | App background |
| Semantic | success / warning / danger / info | Status badges |

- Tenant theme overrides only `--tenant-primary`/logo, validated for contrast (≥ 4.5:1 against text) when saved.
- Dark mode: supported via tokens (`prefers-color-scheme` + toggle).
- **Patterns** (documented in Storybook):
  - Page header with stats cards
  - Filter bar + data table (TanStack Table, server pagination, column visibility, sticky header)
  - Tabbed detail pages
  - Dialog/Sheet forms
  - Status badges per state machine
  - Workflow timeline
  - Empty states with a next action
  - Bulk-action toolbar
  - Import wizard (upload → validate → preview → commit)
  - Printable document layout
- **Status colors are consistent** for every state machine (draft = gray, submitted = blue, approved = green, returned = amber, void/revoked = red).

## 4. Accessibility (WCAG 2.2 AA)

- Semantic HTML, labelled inputs, error messages linked with `aria-describedby`, focus-visible styles, and a skip link.
- Full keyboard operability. **The score entry grid is keyboard-first** (arrow/enter navigation, paste from spreadsheet).
- Color is never the only signal (badges have text).
- Targets ≥ 24×24 px. Respect `prefers-reduced-motion`.
- CI: `eslint-plugin-jsx-a11y` + axe checks in Playwright on key pages. Manual screen-reader pass on critical journeys before GA.

## 5. Performance budgets (low-end Android on slow 4G)

| Metric | Budget |
|--------|--------|
| LCP (student/applicant pages) | ≤ 2.5 s (p75, field data) |
| INP | ≤ 200 ms |
| CLS | ≤ 0.1 |
| Initial JS per route (compressed) | ≤ 170 KB for student/applicant, ≤ 250 KB for staff |
| Largest image | ≤ 150 KB, responsive `next/image` |

Tactics:
- Server Components by default.
- Dynamic import for heavy components (charts, timetable DnD, rich text).
- No moment.js/lodash full imports.
- Self-host fonts (`next/font`) or use the system stack.
- Paginate everything.
- Bundle analyser in CI with budget checks.

## 6. Resilience for Nigerian networks

- **Autosave drafts** (score entry, application form, registration) to the server every 20 s and on blur, plus a local draft (IndexedDB, **non-sensitive fields only**) to survive a lost connection.
- Detect offline/slow status and show a banner. Queue retries with backoff for idempotent actions.
- After a payment redirect, the status page polls the server. It never assumes success from the query string.
- Everything the user may need offline is **printable/downloadable** (course form, docket, receipt, statement of result).
- PWA (installable, offline shell) is `[PHASE 8]`.

## 7. Security in the frontend

- CSP with per-request nonce set in `middleware.ts` ([08 §6](08-security.md)). No inline scripts without the nonce.
- User-generated HTML is rendered only via the `<SafeHtml>` component (server-sanitized + DOMPurify on the client).
- No third-party analytics scripts on authenticated pages. Privacy-friendly, self-hosted analytics on public pages only if needed.
- Never embed personal data in URLs (use IDs, never matric numbers or emails in query strings).
- Payment gateway inline scripts are loaded only on payment pages.

## 8. Internationalisation & formatting

- English (Nigeria) `en-NG` for GA. All strings go through `next-intl` message catalogs so other languages can be added later.
- Currency: `Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' })` from kobo via a single `formatNaira(kobo)` helper.
- Dates: display in `Africa/Lagos` with `date-fns-tz`, e.g. `Mon, 15 Mar 2026, 11:59 PM`.
- Names: support single names, hyphens and apostrophes (`Ọ̀ṣun`, `D'Souza`). Never force uppercase in storage. Display rules are per document template.

## 9. Console app specifics (`apps/console`)

- Separate deployment, host, cookie and CSP. No shared session with tenant apps.
- Dense admin UI is acceptable. **Every destructive action has typed confirmation** (type the tenant slug) and a reason field, and shows the two-person approval status where required.
- Clearly labelled environment banner (STAGING / PRODUCTION).

## 10. Frontend testing

- Unit/component: Vitest + Testing Library (forms, tables, permission-gated nav).
- Storybook for `packages/ui` with interaction tests + visual regression (Chromatic or Playwright snapshots).
- E2E: Playwright per critical journey ([12](12-testing-strategy.md) §5), running on mobile viewport emulation too.
