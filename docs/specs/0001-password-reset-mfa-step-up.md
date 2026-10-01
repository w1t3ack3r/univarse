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
| M9 | *Factor changes revoke other sessions.* Disabling MFA or regenerating recovery codes requires step-up (Part S) and revokes all the user's *other* sessions. **Delivered with Part S** (see M15). |
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

---

## Out of scope for these PRs (tracked)

- Durable, retried email delivery (R15a): the outbox/worker slice.

- Hash-chained audit events for these actions ([07 §7](../07-data-and-database.md)). This is the next slice. Until then, security-relevant events are logged via the `Auth`/`Sessions` loggers.
- WebAuthn/passkeys (Phase 8). SMS as a second factor is **not** allowed for privileged users ([08 §3.2](../08-security.md)).
- HTTPS browser verification of these flows. It stays open in the README matrix until staging exists.
