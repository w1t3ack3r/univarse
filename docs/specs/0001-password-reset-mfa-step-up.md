# Spec 0001 — Password reset, TOTP MFA, step-up

**Status:** Accepted (2026-10-01) · **Phase:** 0 · **Delivery:** three PRs in order: reset → TOTP → step-up.
Each acceptance criterion (AC) gets at least one test whose name contains its ID (e.g. `[R4]`), so coverage is greppable.
Security baseline: [08 §3](../08-security.md).

---

## Part R — Password reset (PR 1)

**Flow:** `POST /api/v1/auth/password-reset/request {username}` → email with a 6-digit code → `POST /api/v1/auth/password-reset/confirm {username, code, password}`.

| ID | Acceptance criterion |
|----|----------------------|
| R1 | *Enumeration-safe request.* Always `202` with an identical body, whether the account exists, is pending, disabled, or has no email. A code is sent only to an `ACTIVE` account with an email. |
| R2 | *Code properties.* 6 digits, stored only as HMAC-SHA256 with the server pepper, bound to user + purpose, valid 15 min. Requesting a new code **invalidates every earlier unused reset code** for that user. |
| R3 | *Attempt limit.* After 5 wrong codes the code is dead: a 6th attempt with the *correct* code fails. |
| R4 | *No reuse.* A successfully used code can't be used again (400). A code issued to user A can't reset user B. A code issued in institution X is useless in institution Y. |
| R5 | *Policy.* The new password must pass the same policy as activation (length by user class, deny-list, no personal info). Violations → `422` with codes. The failed attempt doesn't consume the code. |
| R6 | *Session invalidation.* On success, **every** existing session of that user is revoked (`revoke_reason = password_reset`), including the one that requested the reset, if any. |
| R7 | *No auto-login.* Reset doesn't create a session. The user must log in, which later enforces MFA (Part M). |
| R8 | *Unlock.* A successful reset clears `failed_login_count` and `locked_until`: proving control of the email outweighs a lock caused by someone else's guessing. |
| R9 | *Notification.* A "your password was changed" email goes to the account's address after success. It contains no code or link. |
| R10 | *Rate limits.* Request: 20/15 min per IP and 3/15 min per identifier. Confirm: 30/15 min per IP. Exceeding → `429` + `Retry-After`. |
| R11 | *Ineligible accounts.* Pending accounts must use activation. Disabled or locked-by-admin (`LOCKED`) accounts can't reset (the code is never sent). |

### Added 2026-10-01 after review (R12–R16)

These were missing from the first version of the spec. Two exposed real bugs (R12, R13) that the original 14 tests didn't catch.

| ID | Acceptance criterion | Status |
|----|----------------------|--------|
| R12 | *Concurrent confirms.* N parallel confirmations with the same valid code yield **exactly one** success. | **Bug found**: 4 of 4 succeeded. Fixed with an atomic conditional consume. Test: `reset-hardening.int.spec.ts` |
| R13 | *Concurrent guessing.* Parallel wrong codes can't exceed the 5-attempt budget: every check reserves an attempt with a conditional `UPDATE … WHERE attempts < 5` before comparing. | **Bug found**: 6 attempts were recorded. Fixed the same way. Both R12 and R13 fail when the fix is reverted (mutation-checked) |
| R14 | *Eligibility re-checked at confirm.* An account that becomes `DISABLED` or `LOCKED` after the code was issued can't complete the reset, and its password is unchanged. | Behaviour was already correct; it's now tested |
| R15 | *Timing.* Request and confirm aim for consistent response timing whether or not the account exists (OWASP Forgot Password cheat sheet): (a) code emails are sent without awaiting SMTP, (b) these endpoints have a 400 ms response floor (`withMinimumDuration`). | **Scope of the claim:** the *SMTP timing leak is fixed under the tested conditions*: 250 ms simulated SMTP, median of 7 samples, difference under 40 ms. This is a specific improvement, **not** complete protection against enumeration. A floor hides nothing once processing exceeds 400 ms (DB contention, cold connections, load), and the test doesn't cover those. Residual risk is accepted for Phase 0. Revisit with load-test timing data |
| R15a | *Durable delivery.* Code and notification emails survive process restarts and are retried. | **Not done.** The send is in-process and unawaited, so a message pending at shutdown is lost and failures are only logged. Owned by the outbox/worker slice (roadmap Phase 0) |
| R16 | *Reset invalidates pending MFA challenges.* A password reset revokes every outstanding MFA login challenge for the user. | **Tracked as M11** below. Can't be tested until challenges exist |

## Part M — TOTP multi-factor (PR 2)

| ID | Acceptance criterion |
|----|----------------------|
| M1 | **⚠ Partially met: see the M1 deviation note below.** *Enrolment.* A signed-in user who re-enters their password gets a TOTP secret (RFC 6238, SHA-1, 6 digits, 30 s) as base32 plus an `otpauth://` URI **once**. The secret is stored envelope-encrypted, never in plaintext, and is never returned again. |
| M2 | *Confirmation.* The factor becomes active only after one valid code is submitted. Unconfirmed factors expire after 15 min. |
| M3 | *Recovery codes.* On confirmation, 10 single-use recovery codes are shown once and stored hashed. Regenerating them invalidates all previous ones. |
| M4 | *Two-step login.* With an active factor, a correct password returns `200 {mfaRequired: true}` and a short-lived (5 min), single-use **challenge** cookie, not a session. `POST /auth/mfa/verify {code}` exchanges the challenge for a full session with `mfa_at` set. |
| M5 | *Replay protection.* The same TOTP time-step can't be accepted twice for a user. Clock skew tolerance is ±1 step. |
| M6 | *Attempt limit.* 5 wrong codes on a challenge kill it (the user must re-enter their password). A per-user rate limit also applies. |
| M7 | *Recovery.* A recovery code can replace a TOTP code at verify time, exactly once. Using one emails the user and reports the remaining count. |
| M8 | *Mandatory for privileged users.* A user holding any `privileged` permission without an active factor gets a session that can **only** reach enrolment and logout endpoints until they enrol (`403 auth.mfa_enrolment_required` elsewhere). |
| M9 | *Factor changes revoke other sessions.* Disabling MFA or regenerating recovery codes requires step-up (Part S) and revokes all the user's *other* sessions. **Delivered with Part S** (M9a–M9e, M15′). |
| M10 | *Password reset + MFA.* A password reset (Part R) never removes or bypasses MFA: the next login still requires the second factor. |
| M11 | *(= R16)* A password reset revokes all of the user's pending MFA challenges. A challenge issued before the reset can't be completed afterwards, even with a valid TOTP code. |
| M12 | *Concurrency (applies the R12/R13 lesson).* Parallel verifies of one challenge yield at most one session. Parallel wrong codes can't exceed the challenge's attempt budget. Recovery codes are consumed atomically, so a code can't be used twice in parallel. |
| M13 | *Timing.* Verify timing doesn't reveal whether a challenge or recovery code exists or is valid, beyond pass/fail. Same scoping as R15: tested conditions only. |
| M14 | *Restricted → full session transition.* A restricted (enrolment-only) session from M8 becomes a full session **only** by confirming enrolment. On confirmation the restricted session is **revoked** and a **new token** is issued with `mfa_at` set (no token reuse across privilege levels). Any other restricted session of the same user stays restricted until that user logs in again with MFA. |
| M15 | *No MFA management before step-up.* Endpoints that weaken or change an active factor (disable MFA, remove or replace a confirmed TOTP factor, regenerate recovery codes) **don't exist** in this PR: requests get 404. Enrolment is refused (409) when a confirmed factor already exists. These endpoints arrive with Part S, behind `@RequireStepUp()`. |

### Part M verification notes (2026-10-01)

- **M1 deviation (explicit):** secrets are encrypted at rest with AES-256-GCM, AAD-bound to tenant and user, and are never stored or returned in plaintext. That part is met. They are **not envelope-encrypted**: one platform-wide server key, no DEK/KEK split. This is a temporary deviation recorded in **ADR-018**, which must be closed before staging.
- **Live isolation (added at review):** `mfa_challenge` and `recovery_code` have live cross-tenant read, write, insert, FK and no-context tests **as the app role** (`packages/db/test/isolation.int.spec.ts`). Disabling RLS on both tables fails 4 of them (verified).
- **Challenge single-use (added at review):** new tests cover TOTP-then-unused-recovery-code on the same challenge, and the parallel TOTP + recovery version (exactly one session; the recovery code is spent only if it won). Layered mutation testing found the post-consumption backstop **returned** instead of throwing, which would commit a burned recovery code. Fixed. Now the reservation check and the consume backstop are each independently sufficient and side-effect free (each mutant alone survives), and removing both fails 4 tests.

- **22 tests, one or more per M-criterion.** Mutation checks: disabling the replay guard (M5), session rotation (M14), challenge revocation on reset (M11), the restricted-session guard (M8), or the verify floor (M13) each fails at least one test.
- **~~Accepted equivalent mutant (M12)~~ superseded by the layered analysis above.** The first claim was incomplete: the backstop was not side-effect free.
- **M13 measurement:** without the floor, wrong-code verifies were **~3–4 ms slower, consistently** than unknown-challenge verifies (3 runs). With the 400 ms floor the gap was noise (−5.5 ms). The test therefore also asserts that the floor is in force; a 40 ms tolerance alone cannot see a 3 ms leak. Claim scope: *tested conditions only*, as for R15.
- **Known test gap (reset slice, not reopened):** the R15 test detects the SMTP gap but would not detect removal of the reset floor alone. Fix it the same way when the reset code is next touched.

### Part M design decisions (decided before implementation)

- **Data:** `session.restricted` (bool) and `session.step_up_at`; `mfa_factor.last_used_step` (replay guard, updated with a conditional `UPDATE … WHERE last_used_step < $step`); new tables `mfa_challenge` (hashed token, 5-min TTL, attempts, used/revoked) and `recovery_code` (hashed, single-use). All new tables are tenant tables with forced RLS and composite FKs, so `rls:check` must stay green.
- **Secret at rest:** AES-256-GCM field encryption with a versioned format `v1:<keyId>:<iv>:<ct>:<tag>`. Phase 0 key: `DATA_ENCRYPTION_KEY` from the environment/secret manager, with KMS-wrapped per-tenant DEKs later (ADR to be written with this PR).
- **TOTP:** RFC 6238 implemented in-house (HMAC-SHA1, 30 s, 6 digits, ±1 step), unit-tested against the RFC test vectors. No new runtime dependency.
- **Challenge cookie:** `__Host-uv_mfa`, HttpOnly, Secure, SameSite=Lax, 5 min, opaque, stored hashed. It isn't a session and grants nothing but `/auth/mfa/verify`.

## Part S — Step-up (PR 3)

| ID | Acceptance criterion |
|----|----------------------|
| S1 | Routes marked `@RequireStepUp()` require a step-up within the last **5 minutes** on the *current* session. Otherwise → `428 auth.step_up_required`. |
| S2 | `POST /auth/step-up {password, code?}`: MFA users must supply password + TOTP/recovery code, non-MFA users password only (only possible for non-privileged users; see M8). |
| S3 | Step-up **rotates the session token** (new cookie, old token revoked). |
| S4 | Step-up is scoped to one session: stepping up on device A doesn't elevate device B. |
| S5 | Step-up attempts share login's rate limits and lockout counters. |

### Added 2026-10-01 before implementation (S6–S12, M9 detail, M15 update)

| ID | Acceptance criterion |
|----|----------------------|
| S6 | *Where step-up lives.* `step_up_at` is set only on the **new** session created by the rotation (S3). It is never copied to other sessions, and a session issued by login or MFA verify starts with `step_up_at = NULL`. |
| S7 | *Atomicity.* A TOTP code accepted at step-up goes through the same per-factor replay guard as login (M5). Parallel step-ups with one code yield at most one elevated session. A recovery code used at step-up is consumed atomically and emails the user (as M7). |
| S8 | *Restricted sessions can't step up.* An enrolment-only session (M8) gets `403 auth.mfa_enrolment_required` from `/auth/step-up`, so step-up can't route around enrolment. |
| M9a | *Endpoints (now behind step-up).* `POST /auth/mfa/totp/disable` and `POST /auth/mfa/recovery-codes/regenerate` require `@RequireStepUp()`. Without a fresh step-up → `428`. Replacing a factor = disable, then enrol (enrolment stays refused while a factor is active, M15). |
| M9b | *Regenerate.* Issues 10 new recovery codes (shown once), and **every** previous code stops working immediately, used or not. Revokes all the user's **other** sessions. |
| M9c | *Disable.* Deletes the TOTP factor and all recovery codes, revokes all the user's **other** sessions, and revokes their pending MFA challenges. |
| **M9d** | **Disable by a privileged user → the current session becomes enrolment-only immediately** (review requirement, 2026-10-01). The same response that confirms the disable leaves the session `restricted = true`, `mfa_at = NULL`, `step_up_at = NULL` (rotating the token). Every route except the M8 allow-list (enrol, confirm, logout, `/me`) then answers `403 auth.mfa_enrolment_required`. Revoking other sessions protects other devices; this protects the current one. A **non-privileged** user who disables MFA keeps a normal session, with `mfa_at` and `step_up_at` cleared. |
| M9e | *Notification.* Disabling MFA or regenerating recovery codes emails the user (no codes in the email). |
| M15′ | *Update to M15.* The management endpoints now **exist**, but only behind step-up. The M15 tests change from "404" to "428 without step-up". Enrolment over an active factor stays `409`. |
| S9 | *Permission-flagged step-up.* Permissions marked `stepUp` in the catalog (e.g. `identity.role.assign`, `settings.tenant.manage`) are enforced by the access guard automatically. No route uses them yet, so the guard behaviour is unit-tested now and integration-tested when the first such route lands. |
| S10 | *Concurrency of management actions.* Parallel disables or regenerates by one session leave a consistent end state: exactly one set of 10 recovery codes after regenerate; no factor and no recovery codes after disable. |
| S11 | *Timing.* `/auth/step-up` gets the same 400 ms floor as verify (scoped to tested conditions). |
| S12 | *Lockout parity (S5 detail).* A wrong password at step-up increments the same `failed_login_count` as login. 10 failures lock the account, and the lock also blocks login. |

### Part S verification notes (2026-10-02)

- **Route:** `POST /api/v1/auth/step-up` (on the auth controller, not under `/auth/mfa/`: non-MFA users step up too). The first WIP mounted it at `/auth/mfa/step-up`; corrected to match S2.
- **Atomic rotation (S3/S7, M9d) — bug found in the WIP:** the old token was revoked unconditionally and the new session created in a *separate* transaction after the second factor had already committed. A session revoked mid-request (logout, password reset, a disable on another device, a parallel step-up) could therefore be **resurrected as a new elevated session**, and a losing parallel step-up could burn a recovery code. Now the second-factor check, the counter reset, a **conditional** revoke of the current session (`revoked_at IS NULL` and unexpired, `count === 1` or the transaction rolls back) and the new session commit together. Disable rotates inside its locked transaction too, so M9d can't be left half-applied.
- **S10 lock:** `SELECT … FROM user_account … FOR UPDATE` serialises disable/regenerate per user; regenerate also re-checks, under the lock, that the calling session is still live. Mutation: removing the lock fails the two-device parallel-regenerate test and the disable-vs-regenerate race.
- **S5 parity:** the rate limiter counts per window, so sharing a key is not enough; step-up uses login's exact buckets and rules (50/min per IP; 5/min + 20/h per IP+identifier). **Added beyond the spec:** a per-user step-up bucket (10 / 15 min) so the second factor can't be guessed by rotating IPs. Step-up needs a live session, so this bucket can't be used to lock out someone else.
- **S2 enforced, not just assumed:** a user granted a privileged role after logging in (normal session, no factor) gets `403 auth.mfa_enrolment_required` instead of a password-only step-up.
- **S12:** a successful step-up resets `failed_login_count` (as login does), in the same transaction as the rotation. A correct password with a wrong second factor does not reset it.
- **Guard:** `@RequireStepUp()` on a `@Public()` route is refused and logged as a bug (it could never be satisfied; silently skipping it would fail open). Order: 401 → restricted 403 → permission 403 → MFA 403 → 428, so nobody is invited to step up for something they aren't allowed to do.
- **Tests:** 29 integration tests (`step-up.int.spec.ts`) + 13 guard/unit tests (`step-up.spec.ts`), every S/M9 ID in a test name. **13 mutations, each killed:** user lock, conditional rotation, regenerate liveness check, replay guard, the floor, the per-user and shared login buckets, M9d restriction, `step_up_at` cleared on disable, the S2 privileged check, the guard's step-up check, other-session revocation on disable, the S12 counter reset.
- **S11 scope:** the test asserts the 400 ms floor holds on four failure paths (wrong password, missing code, wrong code, wrong password with a valid code). Same claim scope as R15/M13: tested conditions only.

---

### Part S integration notes (2026-10-04)

Part S was implemented twice in parallel (an interrupted local session and a cloud session). The cloud session's version was adopted because it fixed defects the local version had: non-atomic session rotation (a revoked session could be resurrected as elevated), a recovery code burned by a losing step-up, half-applied M9d on failure, and `@RequireStepUp()` failing open on `@Public` routes. The local version is preserved on branch `backup/step-up-local`. Ported from it:

- **M9c re-enrol test:** the only test that fails when challenge revocation on disable is removed (verified on the adopted code: the old challenge logged in, 200). The existing M9c test is masked because deleting the factor already kills the challenge.
- **M13 interleaved timing samples:** a robustness fix; the floor mutant still fails.
- **M5 step-boundary flake fixed:** the skew test failed when a 30 s TOTP boundary passed mid-test (shifting every offset by one). It now waits for a fresh step (`waitForFreshTotpStep`).
- **Fail-fast test prerequisites:** a `globalSetup` checks Valkey and Postgres. Without it, a stopped Valkey made the fail-open rate limiter look broken (both S5 tests returned 200, not 429).

## Out of scope for these PRs (tracked, with milestones)

| Gap | Milestone |
|-----|-----------|
| Durable, retried email delivery (R15a) | Outbox/worker slice: next Phase 0 slice after spec 0001 |
| Hash-chained audit events for reset/MFA/step-up | Audit slice: Phase 0, alongside the outbox |
| Envelope encryption: KMS-wrapped per-tenant DEKs (ADR-018) | **Gate before the staging environment** |
| HTTPS browser verification (cookies + proxy on real TLS) | Staging environment (Phase 0 exit) |
| Browser verification of reset / MFA / step-up over HTTP | Harness extension at the close of spec 0001 |
| Generic all-table isolation sweep | Phase 0 (before Phase 0 exit) |
| R15 test would not detect removal of the reset floor alone | The next change to reset code |
| Permission-flagged step-up integration test (S9) | The first route using a `stepUp` permission (role assignment, Phase 2) |
| WebAuthn/passkeys | Phase 8. SMS as a second factor is **not** allowed for privileged users ([08 §3.2](../08-security.md)) |

Until the audit slice lands, security-relevant events are logged via the `Auth`/`Sessions`/`Mfa` loggers.
