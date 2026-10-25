# Handoff: finishing Phase 0 (2026-10-26)

Read this before doing anything. It covers where Phase 0 stands, what is left in order, what only the owner can do, and how to work. `CLAUDE.md` and [18-roadmap.md](18-roadmap.md) still apply. Update this file as items close, and delete it when Phase 0 closes.

## Where things stand

- **`main` at `5110b25`.**
  - Spec 0020 PR A, the shred ledger, is complete: A1 (#90), A2 (#91) and A3, the waiver (#96).
  - PR B1 is merged: #103 (`00baee7`) for Vault on Raft, WAL archiving and sealed sets, and #104 (`7c28384`) for the fixes found on the owner's machine and the backup public key.
  - #106 (`81bba38`): the migrate job verifies PostgreSQL, the nodemailer and fast-uri advisories, and mailpit v1.32.0 (the open items below).
  - Since: B2a (#107, `c87b72c`), the OB12 test fix (#109, `07511c2`), spec 0023 (#110, `e6a0066`), the backup tests on Windows (#111, `c347bf7`) and spec 0024 (#112, `5110b25`).
  - Earlier: fastify 5.12.7 (#95), `fix(build)` (#98), the bucket copy's fix (#99), and the docs (#105).
- **Release `releases/2026-10-25-e6a0066.json`,** spec 0023, deployed by the owner on 2026-10-25. It is the stack's current release.
  - **Both Vault tokens renewed:** the deploy printed `app token: renewed, 32.0 days` and `backup token: renewed, 32.0 days`; the smoke check shows both until 2026-11-26. The API and the worker each logged `vault.token.renewed` (2,764,800 s) at start, and renew every 6 hours from then.
  - **Its first two runs stopped, as designed:** Vault was sealed after `stack:down` (unsealed, then deployed again), and then the ledger's destination on `D:` was unreadable at the moment of recovery. The drive was fine a minute later (`ledger status`: authoritative, both copies 2 entries), and the next run passed. An external drive that sleeps or isn't mounted yet stops a deploy, which is the ledger refusing to run without every copy; the remedy is to open the drive, then deploy again.
- **Release `releases/2026-10-25-81bba38.json`,** deployed by the owner on 2026-10-25, before it.
  - **The migrate job's TLS fix, on the owner's PostgreSQL:** both Prisma migration runs connected with the engine's verifying settings, and the bootstrap, `rls:check`, the seed and the keys all passed. The `pg` driver's `sslmode=require` warning no longer prints.
  - **mailpit v1.32.0:** healthy, using 7.8 MiB of its 64 MiB.
  - **Before it:** `2026-10-24-00baee7`, deployed on 2026-10-24 after Vault's migration to Raft. The KEK was identical, the probe decrypted, and 3 of 3 data keys unwrapped.
- **Backups run.**
  - The backup public key is `infra/backup/backup.pub`, fingerprint `sha256:90c83219d8d23b1598dd2b867ebb836ef158b3c47991e99d9ab0c66a2571d84e`. The owner keeps the private key offline.
  - **Two sets are kept:**
    - `20261024T161305Z-e2bd`, the first, needing WAL from `000000010000000000000006`;
    - `20261025T033359Z-02d9`, on the new release, needing WAL from `000000010000000000000011`. Its Vault snapshot is 26.3 KB, the stack's parts 20.5 KB, and the ledger 4.0 KB. Its files are 1.0 KB, an empty tar: the demo tenants have no uploads.
  - Both have 6 sealed files and the ledger at seq 2, and exited 0.
  - Until the owner registers B2a's schedule, `pnpm stack:backup` and `pnpm stack:backup wal` run only by hand. The deploy of `e6a0066` warned of both: WAL staged over an hour, and the two tasks not registered. WAL staged in `univarse-stack-pg-wal-staging` stays inside the stack until shipped.
- **The old Vault file storage, `univarse-stack_vault-data`, is kept, untouched** (B-4). Deleting it is a later explicit owner step, never part of a deploy.
- **The ledger is live, and its bucket copy works.** It is `1b879644-1e96-4d46-acb0-08eaa0e6a786`, created by the deploy of `33ae2d9` with `--init-ledger` on 2026-10-23. Since 2026-10-25 it is authoritative on **2 destinations**: the owner added one. Recovery passes with no failed copy, and `pnpm stack:bucket-check` passes every line (spec 0020, "Implementation notes (fix: the bucket copy)", with the measured memory).
- **A3's decisions 1–7** (approved 2026-10-23) and **PR B's plan, B-1 to B-17** (approved 2026-10-24), are recorded in spec 0020. **B1's 18 decisions made while building:** the owner gave the go-ahead to merge #103 on 2026-10-24, with the PR stating they awaited approval. They are recorded as approved by that go-ahead; the owner may still revisit any of them.
- **The ledger's second destination is on the external drive** (the owner confirmed, 2026-10-25), so the ledger survives losing this disk. The backup sets are still on this disk (the default destination), so they don't, unless the destination moves to that drive (`pnpm stack:backup destination <path>`).

## What is left for Phase 0, in order

1. **`fix(build)`: the undeclared workspace dependencies.** Done (#98).
2. **The bucket fix.** Done (#99), released and deployed. The bucket check passes on the owner's stack.
3. **Spec 0020 PR B: backups, the rehearsed restore and the shred drill.** It is the last unmet exit criterion.
   - **The plan** (spec 0020, "Plan (PR B …), for approval", decisions B-1 to B-17) was approved, all as written, on 2026-10-24.
   - **B1 is done:** merged (#103, #104), released and deployed, Vault migrated, and the first set taken (above). Spec 0020's "Implementation notes (PR B1)" hold the evidence, including what the owner's run found.
   - **B2's plan was approved by the owner, all as written, on 2026-10-25** (spec 0020, "Plan (PR B2 …)", B2-1 to B2-17). It is two PRs, B2a first:
     - **B2a:** `stack:backup status`, the deploy's warnings and the schedule. **Merged** (#107; spec 0020, "Implementation notes (PR B2a)"), with 7 decisions made while building, and its amendment to B2-4, all approved by the owner on 2026-10-25; the owner then registers the schedule (B2-17);
     - **B2b:** the restore engine, `stack:restore-rehearsal`, `stack:drill` and `stack:restore`.

     No release is expected for either. B1 took four things from B2's original split: pruning, the backup's ledger snapshot (BK14), D7's external-drive rule, and every image subcommand B2 needs.
   The handoff's original split, for reference:
   - **B1:**
     - Vault moved to Raft storage (D4);
     - continuous WAL archiving for PITR (D3);
     - `pnpm stack:backup` writing a sealed set with its manifest (D2, D5, BK3);
     - BK9's secrets checks.
   - **B2:**
     - `pnpm stack:restore-rehearsal` into an isolated stack (D9, D10, BK6);
     - the shred drill and its control (D11, BK7);
     - the audit checkpoints (D12);
     - retention, `stack:backup status` with its waiver line, and the daily schedule (D6, BK8);
     - D7's "and the external drive when the backup destination is one" in `ledger waive`.
   - **Spec 0023 comes before B2b** (item 4).
4. **Spec 0023: renewing the stack's Vault tokens.** **Done:** merged (#110), released and deployed on 2026-10-25 (above), with its 7 decisions made while building approved by the owner on 2026-10-25. The text below is its history.
   - **What happens:** around **2026-11-21**, the API and worker lose Transit, failing closed, so every encrypted field becomes unreadable. Around **2026-11-25**, the daily backup loses its Vault snapshot.
   - **The plan:** [spec 0023](specs/0023-vault-app-token-renewal.md), T1–T9, refreshed after B1 for both tokens. Step 0 ran on 2026-10-25: the app token expires 2026-11-21T19:42Z and the backup token 2026-11-25T15:54Z, both with a 768 h period and their own policy only. **Approved by the owner on 2026-10-25, T1–T9 as written.**
   - **Step 0 is done** (2026-10-25). Its first run hit a sealed Vault after a restart, which looked like two dead tokens; that is T9.
   - **Built** (#110), released and deployed on 2026-10-25, well before the 2026-11-14 deadline.

5. **CI and local gates.** **The plan is approved:** [spec 0024](specs/0024-ci-security-gates.md), G1–G12 and H1–H3, all as written, on 2026-10-25 (#112). G12: proprietary, stated by a `LICENSE`, and CodeQL with no upload. Then:
   - **PR A:** Semgrep, CodeQL, osv-scanner, the license check and Checkov, each with a proof that it fails for the reason intended, plus the PR-title check, Dependabot for the actions, and the `LICENSE`;
   - **PR B:** lefthook and commitlint (docs/13 §2's hooks, with H2 and H3's changes).

   The owner makes the new checks required on `main`.
6. **Phase 0 closure.** Reconcile the roadmap. Stale rows include the CI row, which lists Trivy as missing though spec 0013 delivered it, and the compose row (🟡). Record every exit criterion with its evidence. The owner signs off.

**Formally deferred, not Phase 0 work (the owner's decision, 2026-10-23):** BullMQ and Storybook (Phase 1), and resource scopes (Phases 2, 4 and 7).

**Open, not blocking (rechecked 2026-10-24; #106 merged and deployed 2026-10-25):**
- **Dependency advisories.**
  - `pnpm audit` finds no advisory against `@vitest/mocker` 4.1.12, the only version the lockfile resolves. Dependabot alerts #42 and #43 are closed: GitHub shows both as fixed (checked by the owner, 2026-10-24).
  - The same audit found newer advisories, fixed in #106: nodemailer 10.0.11 to 10.1.7 (3 moderate, in the API's mailer), and fast-uri 3.1.8 to 3.1.9 and 4.2.1 to 4.2.3 (moderate and low, under fastify's ajv), through overrides like the existing ones. Every version respects the 3-day release age. `pnpm audit` now reports none.
- **The migrate job's TLS: fixed in #106, and running on the owner's stack.** Spec 0019, "Fix: the migrate job verifies PostgreSQL".
  - The investigation measured it: Prisma's schema engine didn't verify PostgreSQL's certificate with `sslmode=require` (it accepted a self-signed one), and it ignores `verify-full`.
  - The job's URLs are now `verify-full` with `sslrootcert`, and the image's Prisma configs translate them into the only form the engine verifies with. Production refuses any URL that doesn't verify.
- **Third-party images: re-scanned 2026-10-24** (Trivy 0.75.0, the deploy's version, from the registry). Both are still CRITICAL 2 and 3, as on 2026-10-20.
  - **postgres** (pinned digest; HIGH 86). The 2 CRITICALs:
    - libxml2 CVE-2026-6653, a denial of service from crafted XML. Debian 13 has no fix yet. Reaching it needs SQL access to PostgreSQL's XML functions, which the app doesn't use, on the internal `db` network.
    - Go's crypto/tls CVE-2025-68121, in `gosu`. It is only the entrypoint's privilege drop, and makes no TLS connection.
    - Today's `postgres:18` build has the same two, so there's nothing to move to yet. Recheck when Debian ships the libxml2 fix.
  - **mailpit** v1.27 (HIGH 72). The 3 CRITICALs:
    - OpenSSL CVE-2026-31789, twice (libcrypto3 and libssl3), which affects 32-bit systems only;
    - Go's crypto/tls CVE-2025-68121. Mailpit's own TLS is unused: SMTP is plaintext on the internal network, and Caddy terminates its UI's TLS.
    - **Moved to mailpit v1.32.0** (owner's decision, 2026-10-24), pinned `sha256:0790692be935ea4420d085694f7985b1f692ca6a8771ab0e0bd8ba75ac180498`: it scans with CRITICAL 0 and HIGH 0. The stack, dev compose and CI's E2E services all use it. Checked before moving:
      - **The API the E2E reads is unchanged:** `GET /api/v1/search` returns `messages[].ID` and `Created`, and `GET /api/v1/message/{id}` returns `Text`.
      - **The runtime is unchanged:** the same entrypoint, user, ports and `readyz` healthcheck.
      - **`--allowed-hosts` (v1.31.1) is off unless set,** so Caddy's `mail.` host still reaches it.
      - **The changelog from v1.28 to v1.32** lists security fixes, limits (50 MB a message, 1000 connections) and features, and no removed or renamed API.
      - **On the owner's stack (2026-10-25):** healthy. It used 7.8 MiB of its 64 MiB just after the deploy, and 21.4 MiB (33%) later that day. The deploy's own scan shows CRITICAL 0 and HIGH 0.
  - The 158 HIGH findings haven't been reviewed one by one. That is still part of Phase 0's closure.

## What only the owner does (Claude gives the exact commands)

Everything that runs on the owner's Windows machine or touches the stack, the keys or the ledger:
- **Releases:**
  - `pnpm images:release`, signed with the owner's key; they set `COSIGN_PASSWORD`;
  - before a release on this 8 GB machine: `pnpm stack:down`, stop the dev ClamAV, and check the dev Vault is unsealed (`pnpm dev:vault`).
- **The stack:** `pnpm stack:deploy releases/<record>.json`, `stack:keys …`, `stack:smoke`, and the bucket check.
- **PR B's owner steps:**
  - done on 2026-10-24: the X25519 backup key pair, generated offline (the private half never leaves the owner, and is never read); the one-time Vault migration to Raft; the first sealed set;
  - approving the Windows Task Scheduler entry (B2);
  - deleting the old Vault file storage (`univarse-stack_vault-data`), when the owner chooses;
  - choosing the backup destination and the ledger's external drive (`stack:keys ledger add-destination`);
  - the real restore rehearsal and shred drill, whose evidence goes in `docs/ops/drills/`.
- **GitHub:** required checks and branch protection, repo settings, and Dependabot dismissals.

## How to work (the owner's standing rules)

- **Plan first.** Write the design and its decisions, with alternatives and why, in the spec. Review it adversarially before building. The owner approves decisions; they don't hunt bugs.
- **Review after.** Review the diff adversarially, and mutation-check every test: each mutation must turn a test red, and a survivor gets its own test. Report a short list of decisions for approval.
- **Judge every run by its exit code,** not its pass count, and explain every error line before calling a run green.
- **Integration and E2E evidence comes from CI** when the environment lacks the services. Say what ran where, and never claim a run that didn't happen.
- **Merging:**
  - only on the owner's explicit go-ahead, after green CI on the exact final head: `gh pr merge N --squash --match-head-commit <full sha>`;
  - re-verify the checks after any edit to the PR, since editing a PR body can re-run them.
- **Cleanup:** after merging, read `gh pr view N --json state` in a separate step, and only once it says `MERGED` delete the branches and worktree. Never chain cleanup into the merge command (a chained cleanup once closed #89).
- **Branches:** work on a branch, never push to `main`, never force-push over others' work. Conventional Commits with the module as scope.
- **Secrets:**
  - never in code, logs, errors, URLs, fixtures or test output; test assertions never print credentials;
  - never handle the owner's PostgreSQL superuser password, the signing key or its password, or the backup private key;
  - `docs/brand-doc/` stays off GitHub.
- **Never run:** `db:setup` in the owner's main checkout, `docker volume prune`, or `images:prune --apply` without the owner's go-ahead. Don't change repo visibility or billing; no cloud accounts.
- **UI work:** load the design skills first (impeccable and the others in the repo's `.claude/skills`). Keep to the brand: deep green #485550; lime #C0EB6A, never as text on light surfaces; off-white #F4F6F0; Poppins. WCAG 2.2 AA, low-end Android on slow networks.
