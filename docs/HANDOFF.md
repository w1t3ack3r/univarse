# Handoff: finishing Phase 0 (2026-10-24)

Read this before doing anything. It covers where Phase 0 stands, what is left in order, what only the owner can do, and how to work. `CLAUDE.md` and [18-roadmap.md](18-roadmap.md) still apply. Update this file as items close, and delete it when Phase 0 closes.

## Where things stand

- **`main` at `7c28384`.**
  - Spec 0020 PR A, the shred ledger, is complete: A1 (#90), A2 (#91) and A3, the waiver (#96).
  - PR B1 is merged: #103 (`00baee7`) for Vault on Raft, WAL archiving and sealed sets, and #104 (`7c28384`) for the fixes found on the owner's machine and the backup public key.
  - Earlier: fastify 5.12.7 (#95), `fix(build)` (#98) and the bucket copy's fix (#99).
- **Release `releases/2026-10-24-00baee7.json`,** deployed by the owner on 2026-10-24.
  - Vault was migrated to Raft first: the KEK was identical, the probe decrypted, and 3 of 3 data keys unwrapped.
  - #104 changed only `tools/stack` and added `infra/backup/backup.pub`, so it needs no new release.
- **Backups run.**
  - The backup public key is `infra/backup/backup.pub`, fingerprint `sha256:90c83219d8d23b1598dd2b867ebb836ef158b3c47991e99d9ab0c66a2571d84e`. The owner keeps the private key offline.
  - The first set, `20261024T161305Z-e2bd`, completed on 2026-10-24 (exit 0). It has 6 sealed files, the ledger at seq 2, and needs WAL from `000000010000000000000006`.
  - Until B2 registers the schedule, `pnpm stack:backup` and `pnpm stack:backup wal` run only by hand. WAL staged in `univarse-stack-pg-wal-staging` stays inside the stack until shipped.
- **The old Vault file storage, `univarse-stack_vault-data`, is kept, untouched** (B-4). Deleting it is a later explicit owner step, never part of a deploy.
- **The ledger is live, and its bucket copy works.** It is `1b879644-1e96-4d46-acb0-08eaa0e6a786`, created by the deploy of `33ae2d9` with `--init-ledger` on 2026-10-23. Recovery passes with no failed copy, and `pnpm stack:bucket-check` passes every line (spec 0020, "Implementation notes (fix: the bucket copy)", with the measured memory).
- **A3's decisions 1–7** (approved 2026-10-23) and **PR B's plan, B-1 to B-17** (approved 2026-10-24), are recorded in spec 0020. **B1's 18 decisions made while building:** the owner gave the go-ahead to merge #103 on 2026-10-24, with the PR stating they awaited approval. They are recorded as approved by that go-ahead; the owner may still revisit any of them.
- **Recommended, not yet done:** add an external drive as a second ledger destination (`pnpm stack:keys ledger add-destination <path>`). Only it survives losing this disk, and the same holds for backup sets on this disk.

## What is left for Phase 0, in order

1. **`fix(build)`: the undeclared workspace dependencies.** Done (#98).
2. **The bucket fix.** Done (#99), released and deployed. The bucket check passes on the owner's stack.
3. **Spec 0020 PR B: backups, the rehearsed restore and the shred drill.** It is the last unmet exit criterion.
   - **The plan** (spec 0020, "Plan (PR B …), for approval", decisions B-1 to B-17) was approved, all as written, on 2026-10-24.
   - **B1 is done:** merged (#103, #104), released and deployed, Vault migrated, and the first set taken (above). Spec 0020's "Implementation notes (PR B1)" hold the evidence, including what the owner's run found.
   - **B2 is next,** starting with its plan for approval. B1 took four things from B2's original split: pruning, the backup's ledger snapshot (BK14), D7's external-drive rule, and every image subcommand B2 needs. So B2 should need no new release unless it finds otherwise.

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
4. **CI and local gates.** First a short spec for approval: which scanners block a merge and which only report, thresholds, exceptions, and the license policy. Then:
   - one PR for Semgrep, CodeQL (the owner decides whether CodeQL may run on this repo), osv-scanner, the license check and Checkov, each with a check that it fails for the reason intended (like `images:proofs`);
   - one PR for lefthook and commitlint (docs/13 §2's pre-commit gates).

   The owner makes the new checks required on `main`.
5. **Phase 0 closure.** Reconcile the roadmap. Stale rows include the CI row, which lists Trivy as missing though spec 0013 delivered it, and the compose row (🟡). Record every exit criterion with its evidence. The owner signs off.

**Formally deferred, not Phase 0 work (the owner's decision, 2026-10-23):** BullMQ and Storybook (Phase 1), and resource scopes (Phases 2, 4 and 7).

**Open, not blocking:**
- **Dependabot alerts #42 and #43** (`@vitest/mocker`, moderate) are still open, though the lockfile resolves only the patched 4.1.12. Recheck them. Dismissing them is the owner's call, never ours.
- **The migrate job's five PostgreSQL URLs say `sslmode=require`** (`tools/stack/src/render.ts`, `migrate.env`), while every other URL in the stack says `verify-full`. Nothing there says why. Every deploy prints the `pg` driver's warning: today it treats `require` as `verify-full`, but its next major version gives it the weaker libpq meaning, which doesn't verify the certificate.
  - **Investigate first.** The likely reason is Prisma's migrate engine: it doesn't read `NODE_EXTRA_CA_CERTS`, and it needs `sslrootcert` for `verify-full`. If so, the migrations may already connect without verifying PostgreSQL's certificate.
  - **Then fix it:** each connection verifies the certificate (`verify-full`, with `sslrootcert=/ca/ca.crt` where Prisma needs it). Add a test that every rendered URL verifies, and a comment saying why.
- **Third-party image findings at deploy** (D8, reported, not blocking): CRITICAL 2 in postgres and 3 in mailpit, from scans of 2026-10-20. Review them, and refresh the scans, as part of Phase 0's closure.

## What only the owner does (the cloud session gives exact commands)

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
