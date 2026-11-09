# Spec 0032: Contact details: changing an account's email address

**Status:** **Done (2026-11-09).** Approved by the owner, all as written: Q1 to Q15 and Q-A1 to Q-A9 on 2026-11-07, and Q-B1 to Q-B9 on 2026-11-09. PR A (#159) and PR B (#160) merged, and released together with S3, by the owner's decision, in place of Q15's order.
**Phase:** 1, between S3 and S4 ([18](../18-roadmap.md)). It delivers [05 §2](../05-modules-and-features.md)'s "contact update with OTP verification", planned from the start and never built.
**Builds on:**

- [spec 0001](0001-password-reset-mfa-step-up.md): one-time codes, step-up and notification mail, which this reuses;
- [spec 0002](0002-audit-and-outbox.md): audit and outbox in one transaction;
- [spec 0028](0028-console-identity.md): platform identity, where the email is the sign-in identifier, and its closing note on the OWNER's mistyped address;
- [08](../08-security.md) (account takeover), [16](../16-compliance-ndpa.md) (the right to rectification; retention) and the invariants (no addresses in logs or audit metadata; tenant data only through `forTenant`).

## Why

An account's email address looks like a simple field. It isn't: it's where password resets and activation codes go, and on the console it's what you sign in with. **So whoever can change it can take the account over,** and a person who loses access to their old mailbox, or was registered with a typo, can't get in at all. Today nobody can change one: not staff, not institutions' users, not an administrator. The owner's stack account already has a mistyped address, and the same will happen with thousands of imported students.

NDPA's right to rectification also needs it: a person must be able to correct their own data ([16](../16-compliance-ndpa.md)).

This is one capability, for every kind of account, designed around that risk.

## The rules, in one view

| Who | How | What it takes |
| --- | --- | --- |
| **A member changes their own** | Your account, signed in | A step-up, then a code sent to the new address |
| **An administrator corrects someone's** | Staff (console), or the user directory (institutions) | Their permission and a step-up; then the person proves the new address with a code **and their password** |
| **Not activated yet** | The administrator edits it directly | Activation itself proves the address |
| **The last OWNER, with no way in** | The owner's command, on the machine | Machine access, audited |

Every completed change tells the old address, offers an undo for 72 hours, and ends the account's other sessions.

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| Q1 | **One capability, two sides:** the same rules for platform staff and institutions' users, in `packages/domain` as pure functions; each side has its own table and routes, and neither touches the other's data (invariants 1, 11). | Two designs would drift, and the second would be the weaker one. |
| Q2 | **Changing your own needs a fresh step-up** (spec 0028 Q11, spec 0001), then proof of the new address: a 6-digit code to the **new** address, 15 minutes, 5 attempts, peppered and single use, bound to that exact address. Nothing changes until it's confirmed, and the old address keeps working meanwhile. | A stolen session alone can't move the account. A typo can't lock anyone out, because the change never completes. |
| Q3 | **One change pending per account:** a new request replaces the old one. Three requests an hour per account, and the same limit per new address. | Stops the feature being used to send mail at a stranger's address. |
| Q4 | **The answer never reveals whether an address is taken.** The screen always says a code was sent. If the address already belongs to another account, that address gets a notice instead of a code, and confirming fails like a wrong code. | Otherwise the form tells an attacker who has an account. Uniqueness is checked again inside the confirming transaction. |
| Q5 | **Confirming happens in one transaction:** the address changes, it's marked verified, the account's other sessions end, the audit row is written, and the mail is queued. The current session stays. | Invariants 6 and 12. Ending sessions is what removes an intruder who was already in. |
| Q6 | **The old address is told, and can undo it for 72 hours.** Its mail carries an undo code (never a link: no tokens in URLs, invariant 8), for a signed-out page. Undoing restores the old address, ends every session, requires a new password at the next sign-in, and logs `identity.email_change.undone`. The new address is shown masked (`s•••@g•••.com`). | The standard defence against a change the person didn't make. Masking keeps a stranger's inbox from learning the new address. |
| Q7 | **An administrator's correction takes both proofs:** a permission (OWNER on the console; `identity.user.contact.manage` for institutions) with a step-up, then the person enters the code from the new address **and their password** on a signed-out page. | This is for someone locked out of their old mailbox, so they can't be signed in. Needing the password means no administrator can take an account over alone. |
| Q8 | **An administrator can mark the old address as wrong,** and then nothing goes to it: no notice, no undo. It's recorded and audited, and the person gets the notice at the new address. This option exists **only** on the administrator's path and the owner's command. | A typo'd address belongs to a stranger, who shouldn't receive mail about this account, or an undo code. It's not offered to a member on their own account, because an intruder would tick it. |
| Q9 | **An account not yet activated:** an administrator edits the address directly, with the permission and an audit row. | No password exists, and activation itself proves the address. This is what fixes bad imports. |
| Q10 | **The owner's command for the last resort:** `pnpm stack:console owner --correct-email --email <current> --new-email <new>`. It runs on the machine, as `--recover` does (spec 0028 Q14), audited with no actor, and sends the code to the new address. | With one OWNER, a lost mailbox would otherwise be final, because `--recover` mails the address on record. |
| Q11 | **Addresses are recorded verified or unverified:** `email_verified_at` on both account tables, set by activation and by a confirmed change. Existing activated accounts count as verified, as activation proved them; imported ones don't until then. | A later slice can rely on it, and an administrator can see why someone gets no mail. |
| Q12 | **No address in audit metadata, logs, URLs or errors.** Audit rows hold ids and what happened. The pending change's addresses live in its own table (`platform_contact_change`, and `contact_change` with `tenant_id` and forced RLS), encrypted with the field encryption on the tenant side, and blanked once the undo window closes. | Invariant 8 and storage limitation. The table keeps that a change happened; the addresses go. |
| Q13 | **Phone numbers follow the same rules when SMS arrives (Phase 3).** The tables carry a `channel` column from the start, with only `EMAIL` in use. | It's the same risk, and adding the column later would need a migration for nothing. |
| Q14 | **Staff sign in with the new address at once.** On the console the email is the identifier; on the tenant side the username (matric or staff number) doesn't change. New-browser mail and resets follow the new address. | There's no period with two valid identifiers. |
| Q15 | **Three PRs, one release.** **A:** domain, migrations, the platform's routes, the console's screens, the owner's command. **B:** the tenant side: routes, web screens, the permission. **C:** the docs' close, then the release and deploy. | Each reviewable alone. S3 finishes first, so it's one thing at a time on the stack. |

## New threat

| # | Threat | Attack | Controls |
| --- | --- | --- | --- |
| T31 | **Account takeover through the contact address** | A stolen session or a rogue administrator moves an account's email, then resets the password | Step-up and proof of the new address (Q2); the old address told, with a 72-hour undo (Q6); other sessions ended (Q5); an administrator can't complete a change without the person's password (Q7); audited; `identity.email_change.undone` at level `act` |

## Acceptance criteria

1. **Own change:** without a step-up it's refused; nothing changes until the code is confirmed; the old address works until then.
2. **The code:** single use, expires, 5 attempts, valid for that exact address only.
3. **No enumeration:** a free address and a taken one answer identically, in content and in timing within the existing floor; a taken address gets a notice, not a code.
4. **Confirming:** the address changes, other sessions end, the current one stays, audit and mail in one transaction. A race for the same address leaves exactly one winner.
5. **Undo:** restores the address, ends every session, requires a new password, and fails after 72 hours.
6. **An administrator alone can't complete a change:** without the person's password it fails. Out of scope is 404, and a cross-tenant attempt is 404 (the route sweep).
7. **Marking the old address wrong** exists only on the administrator's path and the command, and sends nothing to it.
8. **No address** in any audit metadata, log line, URL or error (tests); blanked after the undo window.
9. **RLS:** `contact_change` has `tenant_id` and forced RLS; `pnpm rls:check` passes.
10. **The E2E:** a member changes their address and signs in with the new one, on desktop and phone, with axe.
11. **Mutation checks** on each control above.
12. **Released and deployed;** the owner corrects their own `gmal.com` address on the stack with this feature.

## The owner's steps

- Approve or change Q1 to Q15.
- After the PRs: the release and the deploy.
- On the stack: correct your own address in Your account. The code arrives in Mailpit, as it does for any address there.

## Affected docs

In this PR: [05 §2](../05-modules-and-features.md), [18](../18-roadmap.md). In the implementation PRs: [03](../03-domain-model.md) (the entities), [06](../06-api-guidelines.md) (the routes), [07](../07-data-and-database.md) (tables and grants), [08](../08-security.md) (T31), [16](../16-compliance-ndpa.md) (rectification, retention).

## Out of scope

- **Changing a username:** a matric or staff number is an institution's record, not a contact detail.
- **Phone numbers:** the same rules, when SMS arrives (Q13).
- **Several addresses on one account.**
- **A hold on password resets after a change:** the undo covers the risk, and a hold would mostly block genuine users.

## PR A: what was built

The platform side, in `packages/domain/src/contact-change.ts` (the rules) and `apps/api/src/platform/identity/contact.service.ts`: the migration, the routes, Your account, Staff, two signed-out pages (`/contact-change`, `/contact-change/undo`), and the owner's command.

**Decisions made while building PR A, approved by the owner on 2026-11-07:**

| # | Decision | Why |
| --- | --- | --- |
| Q-A1 | **"A new password at the next sign-in" is a flag:** after an undo the old password signs in to nothing, answering as a wrong one does, until "Forgot your password?" replaces it. | The password may be the intruder's. It uses the reset that already exists, sent to the address just restored. |
| Q-A2 | **An undo code is 10 characters, not 6 digits,** and is entered with the old address. | It lives 72 hours and works signed out, so it needs to be far harder to guess than a 15-minute code. Five tries, then it's spent. |
| Q-A3 | **An undo closes later changes only, not earlier ones.** | Otherwise an intruder who moved the account twice could use their own undo to close the owner's. There's a test of exactly that. |
| Q-A4 | **An old address is held for its 72 hours:** nobody else can be invited to it or move to it. | An undo may need it back, and uniqueness would otherwise block that. |
| Q-A5 | **A confirmed change and an undo kill every unused code on the account,** and an undo also kills sign-ins waiting for a second factor. | A reset code an intruder asked for must not survive the undo. |
| Q-A6 | **An OWNER correcting someone's address is told if it's taken (409).** Q4 covers a member's own request. | The same OWNER can read the whole staff list, so hiding it protects nothing. |
| Q-A7 | **A member without access can't have their address corrected:** restore them first. | Reinstating is what sends mail, and it starts from a fresh activation. |
| Q-A8 | **Failures on the signed-out confirm page don't count toward the sign-in lockout.** Each change allows 5 tries. | The lockout mails the address on record, which here may be a stranger's. |
| Q-A9 | **The `Staff` page shows the old-address choice only for a proven address.** An unproven one is corrected at once, and it gets nothing either way. | Q9. |

## PR B: what was built

The institutions' side, in `apps/api/src/modules/identity/contact.service.ts`, with the same rules from `packages/domain`: the migration, `contact_change` with forced RLS, the `identity.user.contact.manage` permission, six routes in the OpenAPI document and the route sweep, an hourly pass in the worker, Your account, the Users page, and the two signed-out pages.

**Decisions made while building PR B, approved by the owner on 2026-11-09:**

| # | Decision | Why |
| --- | --- | --- |
| Q-B1 | **The signed-out pages ask for the matric or staff number, not an address.** | A username never changes (Q14), so it finds the account without searching addresses, which are encrypted here. |
| Q-B2 | **`contact_change` holds a keyed hash of each address beside the ciphertext,** under the session pepper, not the data key. It's blanked with them. | The per-address limit (Q3) and the 72-hour hold (Q-A4) have to find an address without decrypting every row. |
| Q-B3 | **An account with no address can add one the same way.** Nothing is told and there's no undo, because there's no old address. | Imports will have blanks, and a person needs an address to reset a password. |
| Q-B4 | **`identity.user.contact.manage` goes to `INSTITUTION_ADMIN` only,** and is privileged with a step-up. The Registrar doesn't get it. | It's account-takeover territory (T31). An institution can't change this today; that comes with custom roles. |
| Q-B5 | **Lacking the permission is 403, as every other tenant route; another institution's user is 404.** | Q7's "out of scope is 404" is about the loaded resource (invariant 2). A 403 here says nothing about any user. |
| Q-B6 | **A locked or disabled user's address can't be corrected.** The Users page offers it only for active and not-yet-activated users. | As on the console (Q-A7): restore them first. |
| Q-B7 | **A correction of a not-yet-activated user sends a new activation code to the corrected address.** | Q9 says the address changes directly. Sending the code saves a second step, and activation is what proves it. |
| Q-B8 | **Each undo code has its own row, and every try spends an attempt on all of that user's open undos.** | The account can have two open undos, so the code has to say which change it is, and guessing mustn't get more tries for having two. |
| Q-B9 | **Your account is a new workspace page, reached from your name at the top,** not from the navigation. | The spec placed the change in "Your account", which didn't exist for institutions' users. A sixth item pushed Settings off a phone's bottom bar. |

## Closing

**Released and deployed:** `69e4ee8`, on 2026-11-09, with S3. Q15 planned S3 first and this one after; once PR A and PR B had merged ahead of the first attempt at S3's release, all three went out in one. On the stack, the owner corrected their own mistyped address through Your account (acceptance criterion 12).

**Tests that had to learn about the new table,** for the next slice that adds one: the isolation sweep's fixture for each tenant table (`packages/db/test/isolation-sweep.int.spec.ts`), and the key sweep's fixture for each encrypted column (`key-sweep.isolation.int.spec.ts`). Both fail until the fixture is added.

