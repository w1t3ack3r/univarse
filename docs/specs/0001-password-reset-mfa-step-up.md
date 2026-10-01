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
| R15 | *Timing.* Request and confirm take the same time whether or not the account exists: (a) code emails are sent without awaiting SMTP, (b) these endpoints have a 400 ms response floor (`withMinimumDuration`). Tested with 250 ms of simulated SMTP latency and median of 7 samples, difference under 40 ms. | **Leak found**: the awaited send created a 267 ms gap, which the test missed with the instant in-memory mailer. Fixed. Trade-off: a failed send is logged, not retried, until the outbox/queue slice |
| R16 | *Reset invalidates pending MFA challenges.* A password reset revokes every outstanding MFA login challenge for the user. | **Tracked as M11** below. Can't be tested until challenges exist |

## Part M — TOTP multi-factor (PR 2)

| ID | Acceptance criterion |
|----|----------------------|
| M1 | *Enrolment.* A signed-in user who re-enters their password gets a TOTP secret (RFC 6238, SHA-1, 6 digits, 30 s) as base32 plus an `otpauth://` URI **once**. The secret is stored envelope-encrypted, never in plaintext, and is never returned again. |
| M2 | *Confirmation.* The factor becomes active only after one valid code is submitted. Unconfirmed factors expire after 15 min. |
| M3 | *Recovery codes.* On confirmation, 10 single-use recovery codes are shown once and stored hashed. Regenerating them invalidates all previous ones. |
| M4 | *Two-step login.* With an active factor, a correct password returns `200 {mfaRequired: true}` and a short-lived (5 min), single-use **challenge** cookie, not a session. `POST /auth/mfa/verify {code}` exchanges the challenge for a full session with `mfa_at` set. |
| M5 | *Replay protection.* The same TOTP time-step can't be accepted twice for a user. Clock skew tolerance is ±1 step. |
| M6 | *Attempt limit.* 5 wrong codes on a challenge kill it (the user must re-enter their password). A per-user rate limit also applies. |
| M7 | *Recovery.* A recovery code can replace a TOTP code at verify time, exactly once. Using one emails the user and reports the remaining count. |
| M8 | *Mandatory for privileged users.* A user holding any `privileged` permission without an active factor gets a session that can **only** reach enrolment and logout endpoints until they enrol (`403 auth.mfa_enrolment_required` elsewhere). |
| M9 | *Factor changes revoke other sessions.* Disabling MFA or regenerating recovery codes requires step-up (Part S) and revokes all the user's *other* sessions. |
| M10 | *Password reset + MFA.* A password reset (Part R) never removes or bypasses MFA: the next login still requires the second factor. |
| M11 | *(= R16)* A password reset revokes all of the user's pending MFA challenges. A challenge issued before the reset can't be completed afterwards, even with a valid TOTP code. |
| M12 | *Concurrency (applies the R12/R13 lesson).* Parallel verifies of one challenge yield at most one session. Parallel wrong codes can't exceed the challenge's attempt budget. Recovery codes are consumed atomically, so a code can't be used twice in parallel. |
| M13 | *Timing.* Verify timing doesn't reveal whether a challenge or recovery code exists or is valid, beyond pass/fail. |

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

- Hash-chained audit events for these actions ([07 §7](../07-data-and-database.md)). This is the next slice. Until then, security-relevant events are logged via the `Auth`/`Sessions` loggers.
- WebAuthn/passkeys (Phase 8). SMS as a second factor is **not** allowed for privileged users ([08 §3.2](../08-security.md)).
- HTTPS browser verification of these flows. It stays open in the README matrix until staging exists.
