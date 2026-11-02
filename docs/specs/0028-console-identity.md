# Spec 0028: Phase 1's S2, platform identity

**Status:** **Approved by the owner on 2026-11-02, all as written:** Q1 to Q18. PR A built; PR B and PR C next.
**Phase:** 1, slice **S2** of [spec 0025](0025-phase-1-control-plane.md) (A3, A4, A5; E5 as a rule).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A3 (platform identity reuses the identity code; TOTP mandatory; the console's session limits; WebAuthn in Phase 8), A4 (the first OWNER only through a CLI job; no sign-up page), A5 (the `platform.*` permissions and their sweep), E5 (no "log in as user");
- [spec 0026](0026-phase-1-start-threat-model-and-storybook.md): this slice closes **T27** (the platform's first account taken over) and the session half of **T23** (session theft and forged requests);
- [spec 0027](0027-console-shell.md): the walls, the `univarse_console` role, the platform API process, `__Host-uv_console_sid` (`SameSite=Strict`), and P-A2 (the platform API holds no tenant credential);
- the tenant identity this mirrors: [spec 0001](0001-password-reset-mfa-step-up.md) (codes, MFA, recovery codes, step-up), [spec 0002](0002-audit-and-outbox.md) (audit and outbox in one transaction), [spec 0018](0018-policy-service.md) (a pure `evaluate()`), [spec 0009](0009-api-route-sweep.md) (the route sweep);
- [08](../08-security.md) §3.2 (MFA for all platform staff) and §3.3 (console sessions: 15 min idle, 8 h absolute);
- **the earlier draft, folded in:** its C4 to C8 (identity, MFA, the invite command, permissions, audit) and its WebAuthn question, which spec 0027 moved here.

## Why

S1 built the console's walls with nobody inside. S2 lets exactly the right people in: the owner first, through a command only the owner can run, then staff the owner invites. Every later slice (the audit viewer, the tenant registry, provisioning) acts as a signed-in, permissioned, audited staff member, so this is the base they all stand on.

The console is the platform's highest-value target (T12). Its sign-in is therefore stricter than a tenant's: TOTP is mandatory from the first sign-in, sessions are short, the cookie is `SameSite=Strict`, there is no sign-up page and no way to act as someone else, and every action is audited in the same transaction.

## What exists, and what's missing

| | Exists | Missing |
| --- | --- | --- |
| Platform tables | `platform_user` (email, name, role, password hash, active), `platform_session` (token hash, idle and absolute expiry, `mfa_at`), `platform_audit_event` (the hash chain, written by `packages/crypto`'s `appendPlatformAudit`) | TOTP factors, recovery codes, one-time codes, known devices, a mail outbox; the session's step-up time and restricted flag |
| Identity code | the tenant's: `password.ts` (Argon2id, the rules), `totp.ts`, `tokens.ts` (tokens, codes, hashes), sessions, codes, MFA, step-up, lockout, all bound to tenant databases through `ShardRegistry` | the same behaviour on platform tables, through the platform API's own connection |
| The platform API | its walls, health, the console role's connection (spec 0027) | routes, permissions, a guard, a key for TOTP secrets, mail |
| The console | its frame and a notice that sign-in comes next | sign-in, enrolment, the account and staff pages |

## Decisions for approval

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| Q1 | **One implementation of the risky parts, separate services.** The pure code is shared as it is: Argon2id and the password rules, TOTP, tokens and code hashing, and `evaluate()`'s pattern. The platform's sessions, codes, MFA, lockout and step-up are their own services in `apps/api/src/platform/identity/`, on platform tables through the platform API's connection. The tenant services are not touched. | A3 says "parameterised by store". Making the tenant services generic would rewrite audited, mutation-tested tenant sign-in to gain a second caller. Sharing the pure code keeps one implementation of the cryptography and the rules, which is where a second copy would hurt. Alternative: generic services now. Rejected: the risk lands on tenant sign-in. This refines A3, so it needs your approval. |
| Q2 | **New platform tables,** in one migration with their grants to `univarse_console`: `platform_mfa_factor` (one TOTP factor per member, its encrypted secret and last used step), `platform_recovery_code` (hashed, single-use), `platform_one_time_code` (activation and password reset: hashed, 15 min, 5 attempts, single-use), `platform_known_device` (a hashed device id per member), `platform_mail_outbox`; `platform_session` gains `restricted` and `step_up_at`. **The role gets exactly what each table needs** (no `DELETE` anywhere but expired codes; `platform_audit_event` insert and read only). `platform_user.totp_secret_enc`, never used, is left in place and dropped in a later release (expand, then contract). | Mirrors the tenant tables (spec 0001), so the behaviour and its tests carry over. Grants arrive with the tables, as spec 0027 P5 set. |
| Q3 | **TOTP secrets are encrypted with the console's own Vault Transit key, `univarse-console-kek`,** through its own token, `CONSOLE_VAULT_TOKEN`, whose policy allows encrypt and decrypt on that key only. The context binds the member's id. The token is renewed like the app's (spec 0023). The platform API still refuses `VAULT_TOKEN`, the tenant API's token. | The console can't decrypt tenant data, and the tenant API can't decrypt staff factors. Alternative: a key in the platform API's env file. Rejected: a key on disk, outside Vault's audit. |
| Q4 | **Mail through a platform outbox, delivered by the platform API itself.** A message is written to `platform_mail_outbox` in the same transaction as the action and its audit row; a small relay in the platform API process sends it (Mailpit locally), at least once, each with its own message id. | Invariant 6, and T28: the tenant worker can stop without stopping staff sign-in, and the other way round. Alternative: the tenant worker sends it. Rejected: it would hold platform rows and couple the two. |
| Q5 | **The first OWNER, by one command the owner runs,** `pnpm stack:console owner --email <address> --name "<name>"`: a one-shot job from the verified API image, with the platform API's settings only. It refuses if any OWNER already exists. It creates the member with no password and sends an activation code; it is audited with no actor. Development has the same command against `.env.console`. **No sign-up route exists** (a test asserts it), and no seeded platform member exists outside development's tests. | A4 and T27. |
| Q6 | **Activation by a one-time code, then a password.** The emailed code is 6 digits, hashed with a pepper of the console's own (`CONSOLE_CODE_PEPPER`, a new stack secret), 15 minutes, 5 attempts, single-use, the same as tenant codes. The password: at least 12 characters, the existing rules, checked against the member's own name and email. | The tenant's proven flow; a link would put a secret in a URL (invariant 8). |
| Q7 | **TOTP before anything else.** After activation, the session is restricted: only the enrolment routes answer. Enrolment shows a QR code and the key, and is confirmed by a code. Then **10 recovery codes are shown once**, and the member confirms they've saved them before the session becomes a full one. Every later sign-in needs a TOTP code or a recovery code. Using a recovery code emails the member. | 08 §3.2 and spec 0025's exit criterion: "login without TOTP is impossible". |
| Q8 | **Sessions:** `__Host-uv_console_sid`, `SameSite=Strict`, `HttpOnly`, `Secure`; **15 minutes idle, 8 hours absolute; at most 3** per member (a fourth sign-in ends the oldest); the token is rotated at sign-in and at step-up, and only its hash is stored. A member sees their own sessions (device, address, last seen) and can end any of them, and signs out. **Every write also passes the CSRF check the platform API already runs** (spec 0027), so `SameSite=Strict` isn't the only defence. | A3 and T23. The tenant allows 5 sessions; the console's limit is A3's 3. |
| Q9 | **Lockout:** 10 failed passwords lock the account for 15 minutes, and the member is emailed; failed TOTP codes count toward it too. A per-address limit runs in the platform API's memory. Answers never reveal whether an account exists, with the same timing for both (the dummy hash). | The tenant's numbers. In memory, because the platform API holds no Valkey credential (P-A2) and runs as one process; a second instance (hosting) needs a shared limit, noted in docs/10. Locally every browser arrives from the edge gateway (spec 0027 P4), so the per-address limit is one shared limit here; the per-account lockout is the one that matters. |
| Q10 | **A new-device email** on every sign-in from a browser not seen before: a random device id in a second cookie, `__Host-uv_console_dev` (one year), stored hashed per member. The email names the time, the address and the browser. | Tells the member about a stolen password at once. No fingerprinting: only a cookie this console set. |
| Q11 | **Step-up:** a TOTP code again, valid for 5 minutes on that session, which rotates its token. Required for every staff change (Q13, Q14), regenerating recovery codes, and ending another member's sessions. `@RequirePlatformStepUp()`, as on the tenant side. | T23: a stolen session alone can't change who has access. |
| Q12 | **Platform permissions:** a `platform.*` catalogue and a pure `evaluate()` in `packages/domain/src/platform/`, with the five roles mapped to permissions in code. S2 adds `platform.self` (one's own account and sessions), `platform.staff.read` and `platform.staff.manage`. Every platform route declares one; **the platform route sweep fails a route that doesn't**, and a refusal is 404. | A5, invariant 2, spec 0009's pattern. Later slices add their permissions. |
| Q13 | **Staff management, OWNER only, with step-up:** invite (email, name, role), which sends an activation code; change a role; deactivate, which **ends every session in the same transaction**, and the guard rereads `is_active` on every request; reinstate (a fresh activation). **No one can deactivate or demote themselves, or the last active OWNER.** The affected member is emailed. | Spec 0025's exit criterion: "a deactivated member's sessions die at once". |
| Q14 | **A lost authenticator:** an OWNER (with step-up) resets another member's MFA; that member's sessions end and they enrol again at their next sign-in. **If the only OWNER loses both the authenticator and the recovery codes,** the owner runs `pnpm stack:console owner --recover --email <address>` on this machine: it resets that OWNER's password and MFA and sends a new activation code, audited. | No one is locked out for good, and every recovery path needs either a second OWNER or the machine itself. |
| Q15 | **Every action audited in the same transaction** (`appendPlatformAudit`), with the actor's id and the address. Each is also a security event where 08 §12 lists it (failed sign-ins, lockouts, privilege changes). Staff emails and names are never in audit metadata, only ids. | Invariant 12 and spec 0026 T26. |
| Q16 | **The console's screens:** activate, sign in, verify (TOTP or recovery code), enrol (with the recovery codes once), home (who you are and your role), your sessions, and staff (OWNER only). Built on `packages/ui`, under the console's CSP, axe-clean at WCAG 2.2 AA, desktop and phone. No mock data. | P6's frame, filled in. |
| Q17 | **WebAuthn:** TOTP now, as A3 approved. **Passkeys become a gate for hosting:** before the console is reachable from anywhere but this machine, platform staff sign in with a passkey (TOTP becomes the fallback). | TOTP can be phished; a passkey can't. Locally the allowlist and `127.0.0.1` bound the risk; on a public host they don't. Alternative: passkeys in S2. Rejected: a large addition to a slice that already has a lot, for a risk that doesn't exist yet locally. |
| Q18 | **Three PRs, one release.** **A:** the migration and grants, the domain (permissions), the platform identity services, the mail outbox and relay, the routes and guard, the CLI, development's wiring, and the integration tests. **B:** the console's screens and the E2E. **C:** the stack (the Vault key and token, the new secrets, the CLI job), then the release and deploy, and the owner's first sign-in. | Each reviewable on its own; the release proves the whole. |

## Acceptance criteria

1. **No sign-up:** no route creates a member except the CLI and an OWNER's invite; a test asserts it across every platform route.
2. **The first OWNER** exists only through the CLI, which refuses a second; activation works once, within 15 minutes, in 5 attempts.
3. **TOTP is mandatory:** a session without a confirmed factor reaches only the enrolment routes, and a sign-in without a TOTP or recovery code gets no session. E2E proves both.
4. **Sessions:** 15 minutes idle and 8 hours absolute; a fourth ends the oldest; a deactivated member's sessions fail on their next request; a tenant session's cookie or token never works on the platform API, nor the other way round.
5. **Lockout and new-device mail** work as Q9 and Q10 say, and answers don't reveal whether an account exists.
6. **Step-up** is enforced on every route Q11 lists (a test per route).
7. **Permissions:** the platform route sweep covers every platform route; a refusal is 404, as an unknown route.
8. **Audit:** every action writes its platform audit row in the same transaction (an integration test per action), with no email or name in its metadata.
9. **The key:** the console's Vault token can't use the tenant KEK, and the platform API refuses the tenant's token.
10. **Mutation checks** on each control above: each one removed fails a test.
11. **Released and deployed,** and the owner signs in on the stack with TOTP.

## The owner's steps

- ~~Approve Q1 to Q18.~~ Done on 2026-11-02.
- After PR C: the release and the deploy, then `pnpm stack:console owner --email <your address> --name "<your name>"`, the activation code from Mailpit (`https://mail.stack.univarse.localhost`), your password, your authenticator app, and your recovery codes, kept offline.

## Affected docs (in the implementation PRs)

- [03 §1](../03-domain-model.md): the new platform entities;
- [06](../06-api-guidelines.md): the platform API's routes and their errors;
- [07](../07-data-and-database.md): the tables and `univarse_console`'s grants;
- [08](../08-security.md) §3.2–3.3 and T23/T27's status; [10](../10-infrastructure-and-deployment.md): the console's Vault key and token, the new secrets, the CLI, the in-memory limit's note for hosting;
- [12](../12-testing-strategy.md): the platform route sweep and the identity tests; [18](../18-roadmap.md): S2's status, and passkeys as a hosting gate (Q17);
- [19](../19-decision-log.md): an ADR for Q3 and Q4 (the console's own key, and its own mail).

## Out of scope

- **No "log in as user", ever** (E5); break-glass is Phase 1b's S9.
- Viewing the audit log and security events (S3); the access review (S3); anything about tenants (S4 on).
- Per-member address allowlists (A6: once there's more than one member); passkeys (Q17).

## Implementation notes (PR A, 2026-11-02)

**Built:**
- **The migration** (`20261102120000_platform_identity`): the staff identity tables, the lockout and session columns, and the console role's grants, column by column for `UPDATE`. It also revokes the tenant API's platform role from every staff identity table.
- **`packages/domain`:** the `platform.*` catalogue, the roles' grants and `evaluatePlatform()`.
- **`packages/contracts`:** the platform API's request and response shapes, and three problem codes (`staff.email_taken`, `staff.own_account`, `staff.last_owner`).
- **`apps/api/src/platform/identity/`:**
  - sessions, credentials (codes, lockout, TOTP under the console key, recovery codes, the sign-in challenge, known devices);
  - the identity and staff services, the mail outbox and its relay;
  - the guard, with its decorators and per-address limit;
  - the routes, and the owner's command (`src/cli/platform-owner.ts`).
- **Development:** `db:setup` writes the console's pepper, a local key and the SMTP address to `.env.console`, keeping the pepper and key if they exist. `dev-run` starts the platform API only once that file has them. `pnpm console:owner` runs the owner's command.
- **Docs:** 03, 06, 07, 08, 10, 12 and 18, CLAUDE.md, and ADR-035.

**Evidence:**
- **Integration** (`platform-identity.int.spec.ts`, 19 tests, and `platform.int.spec.ts`, 10, the role's exact grants and the tenant API's role holding none), against the real platform database as the console role, through the platform API's own HTTP stack. The tests cover:
  - activation, then enrolment, then the recovery codes;
  - a password alone opening nothing, and a TOTP step never used twice;
  - the cookie's attributes, the session cap, and a tenant or forged token opening nothing;
  - lockout, without revealing whether an account exists;
  - new-browser mail;
  - 404 for a missing permission, the same as an unknown route;
  - step-up before an invite; deactivation ending sessions at once; nobody changing their own role or access; role change and MFA reset;
  - recovery codes, and password reset;
  - the first-OWNER refusal, CSRF, and no email in any audit metadata.
- **Unit:** the role × permission matrix (11), the platform route sweep (6), the per-address limit, the owner's command against a fake transaction (5), the last-OWNER rule (3), the configuration's key rules (4). The API's 412 unit tests pass; the repository typechecks; every touched package is lint-clean.
- **Mutations: 24 tried, 24 caught:**
  - the policy (enrolment, role grants, the step-up flag);
  - the guard (permission, explicit step-up);
  - sessions (a deactivated member, the cap) and the cookie's `SameSite`;
  - the TOTP replay guard, single-use recovery and one-time codes, and the lockout;
  - a password alone giving a session, and a full session before the recovery codes;
  - a known browser emailed again, and sessions surviving a reset or a deactivation;
  - one's own account, the last OWNER, an email in audit, a sent mail's body kept;
  - a second first OWNER, the limiter, and the tenant `VAULT_TOKEN` accepted.
- **Run locally against the development database,** with the migration applied there. The owner reruns `pnpm db:setup` after merge, to add the console's settings to `.env.console`.

**Decisions made while building, for approval:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **A sign-in challenge table, `platform_mfa_challenge`,** between the password and the second factor (5 minutes, 5 attempts, single use), and `platform_user` gains `failed_login_count` and `locked_until`, `platform_session` `revoke_reason`. | Q2's list missed them; they mirror spec 0001's proven tables, so a password alone is never a session. |
| Q-A2 | **No `DELETE` for the console role at all:** factors, recovery codes, challenges and sessions are retired by a timestamp, and `UPDATE` is granted column by column. | Q2 allowed deleting expired codes; nothing needs it, and the narrower grant is checked by a test. |
| Q-A3 | **The tenant API's platform role loses every staff identity table,** `platform_user` and `platform_session` included, which the migrator's default privileges had given it in full. | Found while writing the grants: the tenant API could have read staff password hashes and sessions. Nothing in it used them. |
| Q-A4 | **The recovery codes' acknowledgement is enforced by the server:** after enrolment the session can only acknowledge them, and only then is it full. | Q7 says "the member confirms they've saved them before the session becomes a full one"; a UI-only step could be skipped. |
| Q-A5 | **Step-up accepts a recovery code too,** and emails the member when one is used. | The same as the tenant side; a member whose phone is gone can still confirm, and is told. |
| Q-A6 | **Development uses a local console key,** written by `db:setup` and kept across reruns with the pepper; the stack uses Vault (PR C). | A new key on every `db:setup` would make every development authenticator stop working. Production refuses a local key. |
| Q-A7 | **Self-service password reset** by an emailed code: it ends every session, and TOTP is still needed to sign in. | Q2 named the purpose; without it, a forgotten password needs an OWNER. |
| Q-A8 | **The refusals:** 404 `resource.not_found` for a missing permission; 401 with no valid session; 403 `auth.mfa_enrolment_required` and 428 `auth.step_up_required` only to a member who holds the permission. **20 requests a minute per address** on each sign-in route. | Q12's 404, and the tenant API's codes for what to do next. |
| Q-A9 | **The platform contracts live in `packages/contracts`, outside the tenant API's OpenAPI document.** | The console (PR B) shares them; the tenant API's published contract doesn't describe the platform API. |
| Q-A10 | **The owner's command prints the member's id, never the email.** | Invariant 8. |
| Q-A11 | **`dev-run` starts the platform API only when `.env.console` has the console's pepper.** | A file from before S2 would make it refuse to start and, as one child's exit stops them all, take `pnpm dev` down. |

