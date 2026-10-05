# Spec 0005 — Web app skeleton, brand tokens and the sign-in journeys

**Status:** Accepted (2026-10-05) · **Phase:** 0 (roadmap: "Web skeleton: auth pages, workspace shell with permission-driven nav, design system with brand tokens") · **Delivery:** PR A (skeleton, tokens, login + MFA verify + logout, workspace shell) → PR B (activation, password reset, MFA enrolment, step-up).
Every AC ID appears in at least one test name. This spec closes spec 0001's open gap: browser verification of reset / MFA / step-up over HTTP. HTTPS verification stays open until staging.

## Brand (from `docs/brand doc/`, confirmed against the Figma landing page)

| Token | Value | Source |
|---|---|---|
| Deep green (`--uv-primary`) | `#485550` | brand swatch page (Page 7), every mockup |
| Lime (`--uv-accent`) | `#C0EB6A` | same |
| Off-white (`--uv-surface`) | `#F4F6F0` | same |
| White | `#FFFFFF` | same |
| Typeface | **Poppins** | brand typography page |
| Logo | slanted "U" (a closed book with pages); lockups in `Logos/` | brand logo pages |

**Contrast (WCAG 2.2 AA), measured:**

| Pair | Ratio | Rule |
|---|---|---|
| Deep green on white / off-white / lime | 7.80 / 7.17 / 5.70 | ✅ body text |
| Lime or white on deep green | 5.70 / 7.80 | ✅ body text |
| **Lime on white / off-white** | **1.37 / 1.26** | ❌ never for text, icons or focus rings |

So lime is a **fill** (buttons, highlight bars behind deep-green text, badges) or an accent **on deep green**, never text on a light background. The landing page's lime words ("Innovation", "UniVarse") become the highlight-bar treatment from the roll-up banner in the app. Focus rings are deep green on light surfaces and lime on deep green.

## Acceptance criteria — PR A

| ID | Acceptance criterion |
|----|----------------------|
| W1 | *App.* `apps/web` is Next.js 16 (App Router, TypeScript strict, ESLint), served on `:3000`. Tenant from the Host (`demo-uni.univarse.localhost:3000`), as everywhere else. |
| W2 | *Same-origin API.* The browser calls `/api/*` on its own origin. **The edge** (production Caddy; locally `tools/dev-edge`) routes `/api/*` to the API and everything else to the web app, overwriting `X-Forwarded-Host`/`-Proto`. So the API resolves the tenant and its CSRF check sees `same-origin`. Next.js never proxies `/api`. No API URL or token reaches client code. Auth is only the `__Host-uv_sid` HttpOnly cookie, and nothing is stored in `localStorage`/`sessionStorage`. |
| W3 | *Tokens.* Brand colours, Poppins (self-hosted, no runtime request to Google), spacing and radius as CSS variables in `packages/ui`, with the contrast rules above. Light theme only in PR A. Dark mode is tracked. |
| W4 | *Login.* Username or email + password. Errors come from `problem.code` and always show the `requestId`. If the API says `mfaRequired`, the user goes to the MFA step; if `mfaEnrolmentRequired`, to enrolment (PR B, a placeholder until then). |
| W5 | *MFA verify.* A 6-digit code, or a recovery code via "use a recovery code". Wrong codes show a generic error. |
| W6 | *Workspace shell.* After sign-in: the institution's name in the header, the user's name, logout, and a navigation **built from `/auth/me` permissions and `/products`** (active products only). Items the user can't use are not rendered; the API stays the enforcement point. |
| W7 | *Session guard.* Workspace pages require a session. Without one, the user is redirected to login, and nothing personal is rendered before the check. A restricted (enrolment-only) session can reach only enrolment and logout. |
| W8 | *Security headers.* CSP with a per-request nonce, `frame-ancestors 'none'`, no inline scripts without the nonce, `Referrer-Policy: no-referrer`. No third-party scripts. |
| W9 | *Accessibility.* Labelled inputs, errors linked with `aria-describedby`, visible focus, a skip link, targets ≥ 24 px. axe finds no serious or critical violations on every PR A page (checked in E2E). |
| W10 | *E2E.* Playwright against the real API and DB, on desktop and mobile (375 px) viewports: login → workspace → logout. Login with TOTP. Login with a recovery code. A wrong password shows the error. A session from one tenant is rejected on another tenant's host. |

## Acceptance criteria — PR B

| ID | Acceptance criterion |
|----|----------------------|
| W11 | *Activation.* Request a code by username, and get the same message whether or not the account exists. Enter code + new password with the policy feedback from the API. Then sign in. |
| W12 | *Password reset.* The same flow. Afterwards every session is signed out and the user signs in again (spec 0001 R6/R7). |
| W13 | *MFA enrolment.* Re-enter the password, see a QR code (rendered **in the browser** from the `otpauth://` URI, with no third-party QR service) plus the secret as text, confirm with a code, then see recovery codes **once**, with copy and download, and an "I've saved them" confirmation before continuing. |
| W14 | *Step-up.* When the API answers `428 auth.step_up_required`, a dialog asks for password + code and retries the original action once on success. |
| W15 | *E2E.* Activation, reset, enrolment and step-up journeys, with the emails read from Mailpit. These close spec 0001's browser-verification gap over HTTP. |

## Implementation notes (PR A)
- **The edge routes, not Next.js.** Next's built-in rewrite proxy *appends* a client-supplied `X-Forwarded-Host` instead of overwriting it. The edge already overwrites it, so routing `/api` there keeps tenant resolution unspoofable and matches production. The edge's old auth harness page is retired; the web app replaces it.
- **Server Components** call the API directly (`API_INTERNAL_URL`), passing on the incoming Host, the edge-built `X-Forwarded-For` and the user's cookie, so the API sees the same tenant, client IP and session.
- **Error messages** live in `packages/contracts` (`ERROR_MESSAGES`). A test scans the API source and fails if any emitted problem code lacks a message (mutation-checked).
- **Logos are SVG** (exported from the brand source, 2026-10-05): outlined paths, no embedded images, fonts or scripts, 1–8 KB each, in `apps/web/public/brand/` with kebab-case names (`logo-deep.svg` on light surfaces, `logo-lime.svg` on deep green, `icon-deep.svg` as favicon; two-tone lockups `logo-<a>-and-<b>.svg`). Served as static files, never through the image optimiser.
- **Derived tokens**, all measured: muted text `#5D6964` (5.72:1 on white), hover lime `#ADDB52` (deep text 4.84:1), status colours ≥ 5.37:1 on their backgrounds. Form-field outlines use `--uv-input-border` (5.72:1); the light divider `#D7DDD4` (1.38:1) is decorative only.

## Out of scope (tracked)

| Gap | Milestone |
|-----|-----------|
| HTTPS cookie/CSP verification on real TLS | Staging (Phase 0 exit) |
| Dark mode | After PR B, before Phase 1 UI work |
| Storybook + visual regression for `packages/ui` | With the first data-table pattern (Phase 1) |
| Tenant branding overrides (`--tenant-primary`, logo) | Phase 1 console |
| Landing page (public marketing site from Figma) | Separate from the tenant app; not Phase 0 |
