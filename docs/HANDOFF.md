# Handoff: finishing Phase 0 (2026-10-23)

Read this before doing anything. It covers where Phase 0 stands, what is left in order, what only the owner can do, and how to work. `CLAUDE.md` and [18-roadmap.md](18-roadmap.md) still apply. Update this file as items close, and delete it when Phase 0 closes.

## Where things stand

- **`main` at `33ae2d9`.** Spec 0020 PR A (the shred ledger) is complete: A1 (#90), A2 (#91) and A3, the waiver (#96). fastify 5.12.7 is in (#95).
- **Release `releases/2026-10-23-33ae2d9.json`.** Built from `33ae2d9`, with the gates passing and no active exceptions. The owner deployed it with `--init-ledger` on 2026-10-23.
- **The ledger is live.** It is `1b879644-1e96-4d46-acb0-08eaa0e6a786`, authoritative on 1 destination (the primary). It has 0 destructions, so nothing was adopted. Recovery passes.
- **Approved and not yet recorded in the docs:** A3's decisions 1–6 (spec 0020, "Implementation notes (PR A3)"). The owner approved them on 2026-10-23. Record that in the spec, in the first PR that touches it.

## A known bug: the ledger's bucket copy fails

Every recovery reports `bucket copy (evidence only, not relied on) failed: exit 1: Access Denied.` The ledger itself is unaffected: the copy on disk is the authority, and the bucket is evidence only. Found on the running stack on 2026-10-23, with probes that wrote nothing (the bucket is still empty):

1. **The identity lacks a permission.** The ledger identity (`univarse-shred-ledger`) has `Write:uv-shred-ledger` only. Its plain puts are authorized, but a put carrying `ObjectLockMode: COMPLIANCE` and a retain-until date is refused, `AccessDenied (403)`. SeaweedFS 4.48 checks retention as its own action. The binary has `PutObjectRetention`, `GetObjectRetention`, `PutObjectLegalHold` and `BypassGovernanceRetention`. The likely fix is to add `PutObjectRetention:uv-shred-ledger` to that identity in `tools/stack/src/render.ts` (`renderS3Config`), and nothing that can read, list, delete or bypass.
2. **The volume limit is full.** The stack's SeaweedFS runs with `-volume.max=16` (`infra/stack/compose.yml`). All 16 are in use: 7 with no collection, 7 for `uv-quarantine`, 2 for `uv-clean`. SeaweedFS grows a new collection 7 volumes at a time, so `uv-shred-ledger` gets none ("No writable volumes and no free volumes left … Not enough data nodes"). Raise the limit, or set a smaller growth count, with the memory budget in mind (spec 0019: the stack's limits sum to at most 3.5 GB). Measure it, don't guess.
3. **A related deploy-order gap.** The deploy restarts Vault, PostgreSQL, PgBouncer and Valkey early when their configuration changes, but SeaweedFS only after recovery. A changed `s3.json` therefore isn't loaded when recovery copies to the bucket. Restart SeaweedFS right after it starts when its files changed, before `buckets()` and before recovery (`tools/stack/src/deploy.ts`).

**The fix is the first PR.** It needs tests that would have caught each bug:
- a test proving the rendered identity can put with the COMPLIANCE lock headers. It runs against a real SeaweedFS of the same version, in CI. Writing and running it are code work; running it against the owner's stack is not;
- a deploy test for the restart order;
- the volume settings measured.

Afterwards, a release. The owner redeploys, runs `pnpm stack:keys recover`, and runs the post-deploy bucket check (below). That check is also still owed from A2: the first real write, COMPLIANCE retention of 10 years, and the identities' permissions.

**The bucket check** was a one-off script outside the repo. Commit it as `pnpm stack:bucket-check` (in `tools/stack`). It talks S3 through the edge, `https://files.stack.univarse.localhost`, resolving to 127.0.0.1 and verified against `~/.univarse/stack/edge/edge-ca.crt`, with both identities read from `secrets.json`. It prints PASS or FAIL lines only, never a key. Its checks:
- this ledger's entries are present, starting from its genesis;
- every entry on disk is copied;
- object lock is enabled;
- each entry is retained in COMPLIANCE mode for 10 years;
- the ledger identity can't list or read its bucket, or list or write another bucket;
- the app identity can read the bucket (the waiver's `ledger-bucket-read`);
- opt-in only (`--try-delete`): a locked version can't be deleted, even by the app identity.

## What is left for Phase 0, in order

1. **The bucket fix** (above), then a release and the owner's redeploy and bucket check.
2. **Spec 0020 PR B: backups, the rehearsed restore and the shred drill.** It is the last unmet exit criterion. First write the plan for the owner's approval. The proposed split, which the owner has yet to approve:
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
3. **CI and local gates.** First a short spec for approval: which scanners block a merge and which only report, thresholds, exceptions, and the license policy. Then:
   - one PR for Semgrep, CodeQL (the owner decides whether CodeQL may run on this repo), osv-scanner, the license check and Checkov, each with a check that it fails for the reason intended (like `images:proofs`);
   - one PR for lefthook and commitlint (docs/13 §2's pre-commit gates).

   The owner makes the new checks required on `main`.
4. **Phase 0 closure.** Reconcile the roadmap. Stale rows include the CI row, which lists Trivy as missing though spec 0013 delivered it, and the compose row (🟡). Record every exit criterion with its evidence. The owner signs off.

**Formally deferred, not Phase 0 work (the owner's decision, 2026-10-23):** BullMQ and Storybook (Phase 1), and resource scopes (Phases 2, 4 and 7).

**Open, not blocking:** Dependabot alerts #42 and #43 (`@vitest/mocker`, moderate). They are still open, though the lockfile resolves only the patched 4.1.12. Recheck them. Dismissing them is the owner's call, never ours.

## What only the owner does (the cloud session gives exact commands)

Everything that runs on the owner's Windows machine or touches the stack, the keys or the ledger:
- **Releases:**
  - `pnpm images:release`, signed with the owner's key; they set `COSIGN_PASSWORD`;
  - before a release on this 8 GB machine: `pnpm stack:down`, stop the dev ClamAV, and check the dev Vault is unsealed (`pnpm dev:vault`).
- **The stack:** `pnpm stack:deploy releases/<record>.json`, `stack:keys …`, `stack:smoke`, and the bucket check.
- **PR B's owner steps:**
  - generating the X25519 backup key pair offline (the private half never leaves the owner, and is never read);
  - the one-time Vault migration to Raft, and unsealing;
  - approving the Windows Task Scheduler entry;
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
