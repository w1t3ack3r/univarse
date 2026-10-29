# Spec 0026: Phase 1's start: the console's threat model, and Storybook

**Status:** **Approved by the owner on 2026-10-28, all as written:** T-A to T-C (the rows T23 to T30) and SB1 to SB8. Nothing is built from it until Phase 0 is signed off.
**Phase:** 1, slice **S0** of [spec 0025](0025-phase-1-control-plane.md).
**Builds on:**

- [08 §2](../08-security.md): "Revisit the threat model at the start of every roadmap phase. New modules add rows";
- [ADR-027](../19-decision-log.md): Storybook for `packages/ui`, built at Phase 1's start, before the console's first screen;
- [11 §10](../11-frontend-guidelines.md): "Storybook for `packages/ui` with interaction tests + visual regression";
- [spec 0005](0005-web-skeleton-and-auth-ui.md) W9: axe in the E2E journeys;
- [ADR-033](../19-decision-log.md) and [spec 0024](0024-ci-security-gates.md): every new dependency passes the five scanners, `pnpm audit` and the license check, with one exceptions discipline;
- [09 §1](../09-container-security.md): the 3-day release age, and the build-script allowlist.

## Why

S0 is the ground the console is built on, before any console code exists.

- **The threat model.** The console is the platform's highest-value target (T12), and the only row about it today is one line. Spec 0025 decided its shape: a separate API process, a role with no tenant database access, mandatory TOTP, a two-person engine, provisioning jobs. Each of those has threats of its own, and each slice's spec needs a row to answer to. Writing them first means S1 to S8 are reviewed against them, not the other way round.
- **Storybook.** The console will be the second app on `packages/ui`. Before it adds screens, every shared component should be reviewable on its own, in every state, with an accessibility check that fails CI. Today the 10 components are only checked inside the web app's journeys, and only in the states those journeys happen to reach.

## What `packages/ui` holds today

| Where | What |
| --- | --- |
| `index.tsx` (server-safe) | `Button` (variants `action`, `quiet`, `plain`; `block`, `pending`), `buttonClass`, `Card`, `Notice`, `Steps` |
| `client.tsx` (interactive) | `TextField`, `PasswordField` (show/hide), `CodeField` (one-time codes: paste, auto-advance), `ExpiryBar` (a countdown with `onExpire`), `CopyButton` |
| `icons.tsx` | 26 icons |
| `tokens.css`, `components.css` | the brand tokens (deep green #485550, lime #C0EB6A, off-white #F4F6F0, Poppins) and the components' styles |

## Decisions for approval

### The threat model (08 §2)

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| T-A | **Eight new rows, T23 to T30, for the console and its slices,** each with the control that answers it and the slice that builds it (below). T12 stays as the summary row and points to them. | Each slice's spec then names the rows it closes, and the review checks them. Alternative: one longer T12. Rejected: one row can't be checked off slice by slice. |
| T-B | **The console's cookie is `SameSite=Strict`,** not `Lax` like the tenant apps'. | Nobody needs to arrive at the console signed in from a link on another site; `Strict` removes that whole class of cross-site request (T23). The tenant apps keep `Lax`, because students arrive from emails and payment redirects. |
| T-C | **08 §1's assets table gains two rows:** the platform staff's credentials and sessions, and the two-person approvals. | They're what T23, T24 and T27 protect. |

**The new rows:**

| # | Threat | Vector | Primary controls | Built in |
| --- | --- | --- | --- | --- |
| T23 | **Console session theft or forged requests** | A stolen cookie; a request forged from a tenant origin or another site; a session left open | Separate host and `__Host-uv_console_sid` cookie, `SameSite=Strict`; 15 min idle and 8 h absolute; at most 3 sessions; rotated at login and step-up; the allowlist at the edge and in the app (A6); step-up for every write that matters | S1, S2 |
| T24 | **Two-person approval bypassed** | Approving one's own request; approving a payload, then executing a different one; replaying an approval; two accounts held by one person | The approver must be a different staff member, with step-up; the approval binds the payload's hash and is single-use, with an expiry; no solo bypass (A7); the access review (E3) shows who holds which account | S6 |
| T25 | **Provisioning abused or mis-aimed** | A reserved or look-alike slug (`console`, `api`, `www`, a real institution's name); a step that seeds tenant A while provisioning B; a flood of jobs; a half-provisioned tenant served | A reserved-slug list and a confusables check; the tenant id comes from the job's registry row, never from the request; the job isolation tests (spec 0014's pattern); a per-staff rate limit; nothing is served until ONBOARDING, and nothing is ACTIVE until the go-live checklist passes (E6) | S5 |
| T26 | **A platform insider** | A staff member reading tenant personal data, exporting a tenant, or changing entitlements or plans without cause | `univarse_console` has no grant on any tenant database (A2); exports and purges need two people; every action audited in the same transaction; no impersonation (E5); the monthly access review (E3); break-glass, if built, read-only, time-boxed and visible to the tenant | S2, S3, S6, S7 |
| T27 | **The platform's first account taken over** | A sign-up page, a seeded OWNER with a known password, or an activation link sent somewhere else | The first OWNER only through the CLI job the owner runs (A4); no sign-up route at all (a test asserts it); activation by one-time code with an expiry; every later account invited by an OWNER, with step-up | S2 |
| T28 | **The console takes the tenants down with it, or the other way round** | A console bug or overload exhausting shared resources; a tenant traffic spike starving the console during an incident | Its own process and container (A1), its own connection pool and role, its own rate limits; the console's outage stops provisioning but no tenant request | S1 |
| T29 | **Tenant data leaked through a console-requested job** | The worker runs jobs the console asks for (seed, export, purge) with tenant credentials; a forged or edited job payload names another tenant, or an export link leaks | Jobs carry only the registry ids, re-read and checked by the worker; payloads validated by zod; exports encrypted, with a short-lived, single-tenant link, audited; the cross-tenant job tests | S5, S7 |
| T30 | **A malicious development dependency** | Storybook and its addons are large dependency trees, run in CI and on the owner's machine | Dev dependencies of `packages/ui` only, never in an image (a check that the images' SBOMs hold no `storybook` package); the 3-day release age; the build-script allowlist unchanged; the five scanners, `pnpm audit` and the license check on the new tree | S0 |

### Storybook

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| SB1 | **Storybook 10.6 with `@storybook/react-vite`, inside `packages/ui`** (its `.storybook/` and the stories next to the components). Version 10.6 accepts Vite 5 to 8, so the repo's Vite 7 override stays. The release age picks the newest version at least 3 days old (10.6.3 today). | `packages/ui` is plain React with CSS; it needs no Next.js framework adapter, and the stories live where the components do. Alternative: `@storybook/nextjs`, or a separate `apps/storybook`. Rejected: the first adds Next.js to a package that doesn't use it, and the second separates stories from their components. |
| SB2 | **A story for every component in every state it has:** the default, `pending`, `disabled`, an error, a long label, a single word, non-Latin text (`Ọ̀ṣun`), and the phone width (360 px). Plus an icons gallery and a tokens page showing each colour pair with its contrast ratio. | The states the journeys never reach are where things break. The tokens page makes the brand rule (lime never as text on a light surface) visible. |
| SB3 | **Every story is a test, and an accessibility violation fails it.** `@storybook/addon-vitest` runs each story in a real browser (Chromium, through `@vitest/browser-playwright` 4.1.12, matching the repo's Vitest), with `@storybook/addon-a11y` set to fail on any axe violation. | It's the same axe engine as the E2E journeys (W9), on every state rather than only on pages. Alternative: Storybook's test runner. Rejected: the Vitest addon is the current way, and reuses the Vitest the repo already runs. |
| SB4 | **Interaction tests for the interactive components:** `PasswordField` shows and hides; `CodeField` takes a pasted code, advances and goes back; `CopyButton` copies; `ExpiryBar` calls `onExpire` (with fake timers). | Those behaviours are what the sign-in screens depend on; today only the journeys exercise them. |
| SB5 | **It runs inside the required `build-test` job,** after the browsers are installed for the E2E. `storybook build` runs too, to prove the static build works. | No new required check, and no ruleset change for the owner. Alternative: its own job. Rejected: the owner would have to add another required check, and it shares `build-test`'s browser install anyway. |
| SB6 | **A proof that the check bites:** a fixture story with known violations (lime text on off-white, an icon-only button without a name) runs in its own configuration, and the CI step asserts that it **fails, for those two rules**. The fixture is never in the real story set. | Like spec 0013's and spec 0024's proofs: a gate that passes on nothing proves nothing. |
| SB7 | **Nothing is published or deployed.** The static build stays a CI artefact check: no Chromatic or any hosted service (ADR-030), and never in an image or the stack. Visual regression waits: the E2E screenshots stay the visual record, and visual snapshots of stories get their own decision when the console has screens to compare. | A hosted service would send the design system off the machine; snapshots of 10 components aren't worth their upkeep yet. |
| SB8 | **`eslint-plugin-storybook`** with its recommended rules, in the existing lint. | It catches mistakes in story files (an export the test can't find, a misspelt story) in the lint the hooks already run. |

## Acceptance criteria

1. 08 §2 holds T23 to T30 as written above, T12 points to them, and §1's assets table holds the two new rows.
2. `pnpm --filter @univarse/ui storybook` runs locally; `storybook build` passes in CI.
3. Every component in `packages/ui` has a story for each state in SB2, and the icons and tokens pages exist.
4. Every story runs as a test in CI, and an axe violation in any of them fails `build-test`.
5. The interaction tests in SB4 pass, and each fails when its behaviour is broken (mutation checks, as always).
6. The SB6 proof fails for exactly its two rules, and the CI step fails if it ever passes.
7. No image's SBOM contains a `storybook` package.
8. The five scanners, `pnpm audit` and the license check pass on the new dependency tree, or each finding goes through the exceptions discipline (ADR-033).
9. ADR-027 is marked built, and the roadmap's Phase 1 shows S0 done.

## The owner's steps

None beyond merging its PRs (the spec approved on 2026-10-28). No image changes, so no release.

## Affected docs (in the implementation PR)

- [08](../08-security.md): §1 and §2 (T-A, T-B, T-C);
- [11 §10](../11-frontend-guidelines.md): how stories, the accessibility check and the interaction tests run; visual regression deferred (SB7);
- [13 §3](../13-ci-cd-and-workflow.md): the new step in `build-test`;
- [18](../18-roadmap.md): S0 done;
- [19](../19-decision-log.md): ADR-027 marked built.

## Out of scope

The console itself (S1). Visual regression (SB7). Stories for `apps/web`'s own screens: they stay covered by the journeys.

## Sources

- Storybook's [10.1 release notes](https://storybook.js.org/releases/10.1), and the [10.5.0 release](https://newreleases.io/project/github/storybookjs/storybook/release/v10.5.0) (Vitest addon and accessibility addon changes);
- the npm registry, checked on 2026-10-28: `storybook`, `@storybook/react-vite`, `@storybook/addon-a11y` and `@storybook/addon-vitest` at 10.6.5 (10.6.3 released 2026-10-20); `@storybook/react-vite`'s peer range for Vite is `^5 || ^6 || ^7 || ^8`.
