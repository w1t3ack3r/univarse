# Spec 0024: CI security gates, and the local hooks

**Status:** **Approved by the owner on 2026-10-25, all as written:** G1–G11 and H1–H3, with G12 decided (proprietary, stated by a `LICENSE`; CodeQL with no upload). **PR A built** (its implementation notes, below): all 12 decisions made while building were approved by the owner on 2026-10-26, with the `LICENSE` holder's name confirmed; merged as #115. **PR B built** (its implementation notes, below), with H2 and GC8 amended by the owner on 2026-10-26.
**Phase:** 0. It closes the roadmap's rows "CI pipeline with all security scans" (🟡) and "lefthook, commitlint" (❌).
**Builds on:**

- [13 §2–3](../13-ci-cd-and-workflow.md): the local hooks, and the PR pipeline's security stage (gitleaks, Semgrep, CodeQL, osv-scanner, a license check, Checkov);
- [spec 0013](0013-container-images-scan-sign.md):
  - CS7's exceptions (an owner, a statement of evidence, an expiry at most 30 days ahead, checked before any scan);
  - CS12's workflow policy (read-only CI, actions pinned by SHA, bash with `pipefail`);
  - CS13's proofs (every gate fails for its intended reason);
- [09](../09-container-security.md) and [08](../08-security.md) §11: security in the development lifecycle.

## Why

CI already runs:
- gitleaks;
- `pnpm audit --audit-level high`;
- the image gates (Trivy, with zero HIGH/CRITICAL, misconfiguration, secrets, and SBOMs);
- the workflow policy;
- the contract diff.

docs/13 §3 also asks for the five scanners below, and none of them runs yet:

| Scanner | What it finds that nothing here finds today |
| --- | --- |
| **Semgrep** | Insecure patterns in our own code: injection, unsafe deserialisation, weak crypto calls, Node and Express-style pitfalls, GitHub Actions script injection. |
| **CodeQL** | Data-flow bugs: tainted input reaching a sink across functions and files. That's deeper than Semgrep's patterns, and slower. |
| **osv-scanner** | Known vulnerabilities in the lockfile from the OSV database: GitHub's advisories plus others. `pnpm audit` covers only high and critical, from GitHub's database. |
| **The license check** | A dependency whose license the product can't ship under (copyleft, source-available or unknown). |
| **Checkov** | Misconfiguration in the Dockerfiles and the GitHub workflows. That overlaps Trivy's misconfiguration scan for Dockerfiles, and covers workflow rules CS12 doesn't, such as untrusted `${{ }}` input in `run:`. |

Locally, no hook runs at all, and Conventional Commits are followed by hand. Squash merges take the **PR title** as the commit message, so that's what `main`'s history is made of.

## Decisions for approval

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| G1 | **Two PRs.** **A:** the five scanners in CI, with their proofs, a PR-title check and Dependabot for the actions. **B:** lefthook and commitlint locally. | A protects `main`; B is convenience, since hooks can always be skipped with `--no-verify`, and CI stays the real gate. Alternative: one PR. Rejected: B's tooling choices shouldn't hold up A. |
| G2 | **Each scanner blocks on its whole tree, not only on new findings, from a triaged baseline.** PR A's first commit runs every scanner on `main` in report-only mode, and the spec records the counts. Each finding is then fixed, or recorded as an exception, and only then is each gate switched to blocking, in the same PR. | It's the same zero-findings stance as Trivy (CS7), and simpler than diff-only gating, which needs a stored baseline and lets old findings live forever. Alternative: block only on findings new in the PR's diff. Rejected for that reason. |
| G3 | **Thresholds.** Below the threshold, findings are printed in the job summary, never hidden:<br>• **Semgrep:** `ERROR` severity blocks; `WARNING` is reported;<br>• **CodeQL:** `error` and `warning` results of the `security-extended` suite block; notes are reported;<br>• **osv-scanner:** any known vulnerability blocks, of any severity: OSV gives no reliable severity for every entry, and a vulnerable lockfile entry is cheap to fix or to except;<br>• **the license check:** a production dependency outside the allowlist blocks (G6); development-only dependencies are reported;<br>• **Checkov:** any failed check blocks. | Strict where it's cheap: osv and Checkov findings are usually a one-line bump or setting. Semgrep and CodeQL's lower severities are noisy by design. Alternative: block on high and critical only everywhere. Rejected for osv, because `pnpm audit` already does that. |
| G4 | **Exceptions, one rule for all five, like CS7's:**<br>• each exception records its id, the finding, a statement (the evidence, not an opinion), an owner and an expiry at most 30 days ahead (365 for a license, which doesn't change);<br>• a check runs before the scans, and fails on a missing field or a past expiry;<br>• every active exception is printed on every run;<br>• the forms are each tool's own: `osv-scanner.toml` `[[IgnoredVulns]]` (with `ignoreUntil` and `reason`); `// nosemgrep: <rule> -- <reason>`; `# checkov:skip=<id>: <reason>`; a CodeQL `query-filters` entry with a comment; the license file below.<br>The check refuses an inline suppression without a reason, and a blanket one (a bare `nosemgrep`, a skipped framework). | One discipline, so an exception is always findable and always dies. Alternative: suppress freely in code. Rejected: that's how findings rot. |
| G5 | **Supply chain of the scanners themselves:**<br>• **osv-scanner:** its release binary, checksum-verified, as gitleaks and Trivy are;<br>• **Semgrep and Checkov:** their official images, pinned by digest;<br>• **CodeQL:** `github/codeql-action`, pinned by SHA (it bundles its CLI);<br>• every version is recorded in the workflow, and bumped by PR.<br>Semgrep's registry rule packs (`p/typescript`, `p/nodejs`, `p/owasp-top-ten`, `p/github-actions`, `p/dockerfile`) are fetched fresh each run, with metrics off, as Trivy's database is. | Pinned engines, fresh rules: a gate that never learns new rules is false comfort, and a pinned engine keeps a run reproducible enough. Alternative: vendor the rules into the repository. Rejected: it's a snapshot that ages silently. |
| G6 | **The license policy.** These licenses are **allowed for production dependencies:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0 and Zlib.<br>**Refused:** GPL, AGPL, LGPL (for now), SSPL, BUSL, the Commons Clause, "UNLICENSED" and unknown.<br>The check reads `pnpm licenses list --prod --json` (pnpm's own command, no new dependency) for each app and package that ships. Its exceptions live in `infra/security/license-exceptions.yaml`. | This is for **a proprietary, hosted product**: AGPL and SSPL would require releasing our own source, and GPL constrains distribution. **This depends on the owner's licensing intent: see G12.** Alternative: a third-party license checker. Rejected: pnpm's command already resolves the workspace's real graph. |
| G7 | **CodeQL runs read-only, with no upload.** `github/codeql-action` with `upload: never`, and the SARIF it writes is checked by our script (G3), so the job keeps `contents: read`, as CS12 requires. The results are attached to the run as an artifact. | Uploading to GitHub's code scanning needs `security-events: write`, which CS12 bans where PR code runs, for good reason. Alternative: allow that one permission on that one job, and amend CS12. That brings the "Security" tab's UI, and can come later as the owner's decision. |
| G8 | **Proofs, CS13's way.** Each gate must fail for its intended reason, with fixtures that never ship, in `tools/security/fixtures/`:<br>• **Semgrep:** a planted `eval` of request input;<br>• **osv-scanner:** a fixture lockfile with a known-vulnerable version;<br>• **the license check:** a fixture package with an AGPL license;<br>• **Checkov:** a Dockerfile running as root, and a workflow with `${{ github.event.pull_request.title }}` in `run:`;<br>• **CodeQL:** a tiny fixture database with a command injection;<br>• **the exceptions check:** an expired entry, and a reason missing.<br>The fast ones run every time; CodeQL's in its own job. | Without proofs, a misconfigured scanner looks exactly like a clean tree. Alternative: trust each tool's exit code. Rejected after CS13 found gates that passed for the wrong reason. |
| G9 | **Jobs and required checks.** Two new jobs:<br>• **`security-scans`:** the exceptions check first, then Semgrep, osv-scanner, the license check, Checkov and their proofs, and the PR-title check. In parallel with `build-test`, target under 5 minutes;<br>• **`codeql`:** in parallel, target under 15 minutes.<br>The owner adds both to `main`'s required checks. | Parallel jobs keep CI's critical path unchanged. Alternative: steps inside `build-test`, which is already about 20 minutes. Rejected. |
| G10 | **The PR title is checked as a Conventional Commit in CI**: `type(scope): description`, with the types `feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor` and `perf`, and a scope required, lowercase. | The squash merge makes the title `main`'s commit message, so this is the gate that keeps history clean, whatever the local hooks did. Alternative: commitlint on every commit in the PR. Rejected: those commits disappear in the squash. |
| G11 | **Dependabot version updates for the GitHub Actions,** weekly (`.github/dependabot.yml`). The workflows say "Renovate bumps them", but no bot is configured. | Pinned SHAs go stale silently otherwise, missing security fixes to the actions. Security updates for npm already arrive (#100, #102). Alternative: Renovate. Rejected: one more app on the repo for the same job. |
| G12 | **Decided by the owner, 2026-10-25:**<br>• **the product is proprietary.** G6's policy stands as written: copyleft and source-available licenses are refused for production dependencies;<br>• **CodeQL runs, with no upload.** G7 stands as written: read-only, the SARIF checked by our script and kept as a run artifact. CS12 is unchanged. | The repository is public but has no license file, so it is "all rights reserved" by default, which matches. **Confirmed by the owner (2026-10-25):** PR A states it explicitly, with a `LICENSE` ("All rights reserved") and `"license": "UNLICENSED"` in the root `package.json`. |

**PR B: the local hooks** (lefthook and commitlint, from docs/13 §2, with three changes):

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| H1 | **lefthook as a dev dependency, installed by `pnpm prepare` (`lefthook install`), with no postinstall script.** The workspace's `onlyBuiltDependencies` list stays as it is. lefthook ships its binary as a platform package, so nothing is downloaded at install time. | It keeps the "only these packages run install scripts" rule intact. Alternative: Husky. Rejected: it runs shell scripts, and lefthook's parallel, staged-file hooks are faster. |
| H2 | **pre-commit**, under 10 s:<br>• `eslint` on the staged files;<br>• `gitleaks protect --staged`, using a pinned, checksum-verified gitleaks fetched by `pnpm tools:gitleaks` (the same version and checksum as CI). It's never fetched unverified, and if it's absent the hook says how to get it, rather than skipping silently.<br>**commit-msg:** commitlint, with `@commitlint/config-conventional`, G10's types, and a scope required.<br>**pre-push:** `turbo run typecheck --affected`. | `tsc -b` moves from pre-commit (docs/13 §2) to pre-push: it can't stay under 10 s across the workspace. Alternative: pre-commit typecheck. Rejected for the 10-second budget.<br>**Amended by the owner, 2026-10-26** (PR B's notes): ESLint moves to pre-push too, and the commit-msg check is G10's own code instead of commitlint. Measured on the owner's machine, ESLint took 10–11 s and commitlint 4–5 s, so a commit took 17–18 s. |
| H3 | **Prettier is left out of the hooks for now.** `main` isn't Prettier-clean (its own files fail `prettier --check`), so a staged-files check would reformat whole files on touch, mixing formatting into every change. The fix is one formatting-only PR, then `format:check` in CI and in the hook. That's the owner's call, since it touches nearly every file once. | docs/13 §2 is amended to say so. Alternative: enforce it now. Rejected: diffs become unreviewable. |

## Acceptance criteria

| # | Criterion |
| --- | --- |
| GC1 | `security-scans` and `codeql` run on every PR and on `main`, in parallel with `build-test`, read-only (CS12's policy passes, and is extended to check the new jobs). |
| GC2 | Each scanner blocks at G3's threshold on the whole tree. `main` passes, after G2's triage, with every remaining finding an exception (G4). The spec records the baseline counts and each finding's outcome. |
| GC3 | Every G8 proof fails at its own gate with the expected message, and a clean fixture passes. |
| GC4 | The exceptions check refuses: a missing field, a past expiry, an expiry too far ahead, a suppression without a reason, and a blanket suppression. It prints every active exception. |
| GC5 | Every scanner is pinned (G5): a version and a checksum, or a digest, or a SHA. A changed checksum fails the job. |
| GC6 | The PR-title check refuses a title without a type, without a scope, or with an unknown type, and accepts this repository's recent titles. |
| GC7 | `.github/dependabot.yml` covers `github-actions`, weekly. |
| GC8 | **PR B:** on a fresh clone, `pnpm install` installs the hooks, and:<br>• a commit with a planted fake secret, or the message "update stuff", is refused;<br>• a push with a lint error or a type error is refused (amended 2026-10-26, with H2);<br>• a normal commit passes in under 10 s;<br>• `--no-verify` still works: CI is the gate. |

## The owner's steps

1. **G12 is decided** (2026-10-25): proprietary, stated by a `LICENSE` and `"license": "UNLICENSED"` in PR A; and CodeQL with no upload.
2. **After PR A merges:** add `security-scans` and `codeql` to `main`'s required checks.
3. **Optionally:** approve a one-time formatting PR (H3), after which Prettier joins CI and the hook.

## Affected docs (in the implementation PRs)

- **[13 §2–3](../13-ci-cd-and-workflow.md):**
  - the hooks as built: typecheck at pre-push, Prettier deferred;
  - the required checks;
  - "Renovate" corrected to Dependabot.
- **[spec 0013](0013-container-images-scan-sign.md) CS12:** the policy's coverage of the new jobs, and an amendment only if the owner chooses CodeQL upload (G7).
- **[18](../18-roadmap.md):** the two rows, with evidence.
- **[19](../19-decision-log.md):** an ADR, "Security scanning gates", recording G2–G7.
- **`docs/HANDOFF.md`.**

## Out of scope

- DAST (ZAP) and the nightly jobs in docs/13 §3's `main` lane. Those come with a staging-like target, later.
- Mutation testing in CI. Mutation checks stay a review practice, done per change.
- Reformatting the repository (H3's own PR, if the owner approves it).

## Implementation notes (PR A: the CI security gates)

Built as approved, G1 to G12's PR A part. It changes the API image (the GCM fix below), so a release follows.

**What runs where.**

- **`tools/security/`, plain Node, with no new dependency (js-yaml was already in the workspace):**
  - `exceptions.mjs` (G4): the exceptions check, run before any scan. It reads:
    - `osv-scanner.toml`;
    - `infra/security/license-exceptions.yaml`;
    - the CodeQL config's `query-filters`;
    - every inline `nosemgrep` and `checkov:skip` in the tracked code and config.
    It prints every active exception.
  - `gates.mjs` (G3, G8): one decision per scanner report, at G3's threshold. With `--expect <finding>` it becomes a proof: it passes only when the gate blocks, and blocks for that finding. An unreadable report fails.
  - `licenses.mjs` (G6): `pnpm licenses list --prod` and `--dev`, with SPDX `AND`/`OR` expressions parsed. Production blocks; dev-only is reported.
  - `pr-title.mjs` (G10): the title is read from the environment, never interpolated into a shell command. All 80 recent titles on `main` pass.
  - `security.test.mjs`: 15 tests, run by `node --test` in the job.
  - `fixtures/`: the proofs' inputs. They are never shipped, and are excluded from the real scans.
- **`.github/workflows/ci.yml`, two new jobs** (G9), in parallel with `build-test`, read-only:
  - **`security-scans`:** the PR title, the tests, the exceptions check, then Semgrep, osv-scanner, the licenses and Checkov, each on the whole tree, then every proof.
  - **`codeql`:** `security-extended`, with `build-mode: none` and `upload: never`, then the gate on the SARIF, then the proof on its own fixture database. The SARIF is kept as a run artifact.
- **Pinned (G5):**
  - Semgrep 1.180.0 and Checkov (the 3.3.28 tag, whose CLI reports 3.3.27), by image digest;
  - osv-scanner 2.7.0's release binary, by SHA-256;
  - `github/codeql-action` v4.38.3, by commit SHA.
- **`.github/codeql/codeql-config.yml`**, **`osv-scanner.toml`** (no exceptions yet) and **`.github/dependabot.yml`** (G11: the actions, weekly).
- **`LICENSE`** and `"license": "UNLICENSED"` (G12).
- **The workflow policy (CS12)** checks every job of every workflow, so the two new jobs are covered without changing it. It passes.

**The baseline (G2), on `main` before the fixes.**

| Scanner | Found | Outcome |
| --- | --- | --- |
| Semgrep | 10 results, plus 8 partial-parse warnings | **5 ERROR, `gcm-no-tag-length`:** fixed (below).<br>**2 in `tools/ci-policy/fixtures`,** the workflow policy's own planted violations: excluded from the scan.<br>**3 MEDIUM pnpm-setting suggestions** (`trust-policy`, `block-exotic-sub-dependencies`, `minimum-release-age`): reported, not blocking.<br>**The partial parses:** reported. |
| osv-scanner | 0 of 669 packages | — |
| Licenses | 340 production packages; 4 outside the allowlist | **MIT-0** added to the allowlist; four exceptions (below).<br>**Dev-only, reported:** MPL-2.0 (`axe-core`, `lightningcss`), and `map-stream` with no license. |
| Checkov | 8 Dockerfile findings; 416 workflow checks passed | `CKV_DOCKER_2` and `CKV_DOCKER_7` on the four Dockerfiles: inline skips, each with its reason. |
| CodeQL | 17 results in CI's first run (#115), all `security-extended` warnings and errors | **14 fixed:**<br>• `js/file-system-race` (7 of 10): a check, then a read or write of the same path, in `setup-local.ts`, `dev-secrets.mjs`, `vault-dev.mjs`, `deploy-deps.ts` (2), the backup's `readTree` and the route sweep. Each now reads directly and treats `ENOENT` as absent;<br>• `js/biased-cryptographic-random` (2, in tests): `randomInt`;<br>• `js/redos` (a test's regex): `[ \t]` for `\s`, so a newline can't be matched two ways;<br>• `js/incomplete-multi-character-sanitization`: the API-contract gate strips HTML comments until nothing changes, so `<!-<!-- -->- … -->` can't leave a hidden acknowledgement visible;<br>• `js/incomplete-sanitization` (2): the contract summary escapes backslashes before pipes, and the PgBouncer proof escapes every regex metacharacter of a version;<br>• `js/regex/missing-regexp-anchor`: only `_URL` is a suffix, now said plainly.<br>**3 suppressed inline** (decision 12): `js/file-system-race` in `pgbouncer-config.spec.ts`, where the race is what the test proves.<br>**The second run found 2 more:** the same test regex, still ambiguous over a run of tabs (now `[ \t]+\S.*`: an indent ends at the first non-blank), and `js/file-access-to-http` in `tools/vault-dev.mjs`, suppressed inline: the dev-only script calls the dev Vault named in the git-ignored `.env`, with the token from the git-ignored `.vault-dev.json`, by design. |

**After the fixes, run here:**
- **Semgrep:** 0 blocking in 626 files. 4 reported: the three pnpm settings, and a Dependabot cooldown, now set (decision 10).
- **Checkov:** 0 failed; 395 Dockerfile checks passed, 8 skipped inline, 496 workflow checks passed.
- **The exceptions check:** 12 active, all valid.

**The GCM fix.** Every AES-256-GCM decipher now passes `authTagLength: 16`:
- `packages/crypto/src/cipher.ts`, which exports `TAG_BYTES`;
- `providers.ts`, the `LocalKeyProvider`;
- `tools/stack/src/backup/seal.ts`, at all three sites, where `setAuthTag` also moved inside the `try`, so a short tag fails as the same `SealError` as a wrong passphrase.

Without the option, Node accepts a tag as short as 4 bytes, so a forger has only 2³² tries instead of 2¹²⁸. Tests, each mutation-checked:
- a genuine tag truncated to 4 bytes is refused, by the field cipher and by `LocalKeyProvider` (`crypto.spec.ts`);
- a sealed private file with a truncated tag fails with `SealError` (`seal.spec.ts`).

**Decisions made while building.** All 12 were approved by the owner on 2026-10-26.

1. **MIT-0 joins G6's allowlist.** It is MIT without the attribution clause, so it's more permissive than MIT.
2. **Four license exceptions, each for 365 days** (`infra/security/license-exceptions.yaml`, not G6's `licenses.yaml`: the name says what it holds):
   - **`LIC-sharp`:** libvips (`@img/sharp-*`), LGPL-3.0, inside Next.js's optional image optimiser. It's loaded dynamically and unmodified, and the LGPL's obligations attach to distribution, which a hosted product doesn't do;
   - **`LIC-elkjs`:** EPL-2.0, in Prisma Studio, shipped only with the Prisma CLI in the migrate image. EPL is weak, file-level copyleft, and it's used unmodified;
   - **`LIC-caniuse-lite`:** CC-BY-4.0, browser-support data through Next.js, not code; the attribution travels with the package;
   - **`LIC-poppins`:** OFL-1.1, the brand font (`@fontsource/poppins`). The OFL allows embedding it in commercial software.
3. **An inline suppression carries a reason but no expiry,** while a file-based exception must expire. An inline one sits beside the code it covers and is reviewed with every change to it; a file entry is far from its code and would rot. The check refuses a bare `nosemgrep` and a suppression without a reason (GC4).
4. **Semgrep's partial-parse errors and its MEDIUM pnpm suggestions are reported, not blocking,** as G3 says for everything below `ERROR`. The three pnpm settings are worth a later look.
5. **The GCM fix,** above, with `setAuthTag` inside the `try`.
6. **The Checkov skips:**
   - **`CKV_DOCKER_7`** (a base image without a tag): our base images are build `ARG`s, pinned by tag and digest, which Checkov can't resolve.
   - **`CKV_DOCKER_2`** (no `HEALTHCHECK`): each image's reason is its own. The API, web and PgBouncer runtimes are distroless, with no shell or curl to run one; the API and the web app are probed from outside by `stack:smoke` after every deploy, and PgBouncer is proved by use. The migrate image is a one-shot job whose exit code is its health.
   - **A gap found while writing them:** only PostgreSQL and Vault have a compose healthcheck. The API, the worker, the web app and PgBouncer have none. It's a separate change, for later.
7. **The proofs' findings differ from G8's examples where a real rule was a better proof:**
   - Semgrep proves on a GCM decipher without a tag length, the very rule that found the baseline's bugs, rather than an `eval`;
   - Checkov proves `CKV_DOCKER_3` (no `USER`, so root) and `CKV_GHA_2` (a PR title in `run:`);
   - CodeQL proves `js/command-line-injection`;
   - osv proves `GHSA-35jh-r3h4-6jhm` (lodash 4.17.20).
8. **The `codeql` job has `actions: read` beside `contents: read`:** `codeql-action` reads the workflow run to describe it. Both are read-only, and CS12 allows them.
9. **The `LICENSE` names the holder as "Samuel Opemipo".** Confirmed by the owner, 2026-10-26.
10. **Dependabot waits 7 days** (`cooldown`) before proposing an action's new release, as Semgrep's baseline suggested. A compromised release is usually caught and pulled within days.
11. **The Checkov gate also trusts the report's summary.** With `--quiet`, Checkov lists only the failed checks, so the gate blocks on a failure the summary counts but doesn't list, and on any file it couldn't parse. It reports the skips by count; the exceptions check lists each one with its reason.
12. **CodeQL gets an inline suppression, like Semgrep's and Checkov's:** `// codeql[<rule-id>]: <reason>`, CodeQL's own syntax, on the line above the result. G4 gave CodeQL only `query-filters`, which drop a rule everywhere. The three results it covers are in a test that holds a file open while it's replaced, to prove a reader never sees the new verifiers: the race is the thing tested, and rewriting the test to dodge the rule would hide that. The gate honours only a valid suppression naming that result's rule; the exceptions check refuses one without a reason or without a single rule, and prints each (now 16 active).

**Evidence.**

- **`node --test tools/security/security.test.mjs`:** 17 of 17 pass. **29 of 29 mutations caught** (S1–S29): each threshold, each exception rule, the proofs' `--expect`, an unreadable report, the title's type, scope and separator, the Checkov summary's three counts, `nosem` in either case, and the CodeQL suppression (its rule, its reason, and the gate honouring it).
- **Each proof was run here** on its fixture, and fails for its finding: Semgrep, osv-scanner, Checkov (both), the licenses, and the four exceptions fixtures (an expired entry, a bare `nosemgrep`, a `checkov:skip` without a reason, a license exception without an owner).
- **Each proof checks its failure's message,** not only its exit code: a crash also exits non-zero. Run here under CI's bash, with three wrong cases, each failing the proof: a missing fixture, the wrong fixture, and a clean tree.
- **The osv fixture isn't named `pnpm-lock.yaml`,** so GitHub's dependency graph doesn't raise a real alert for its planted lodash. osv-scanner is told its format, and the proof passes here.
- **The inline check reads `nosem` as well as `nosemgrep`, in any case,** as Semgrep does. A bare `// nosem` would otherwise have suppressed every rule unseen.
- **The GCM tests:** 4 of 4 mutations caught (G1–G4).
- **Unit, lint and typecheck:** `packages/crypto` 49 of 49, `tools/stack` 439 of 439 (1 skipped); `pnpm ci:policy` and its 9 tests pass.
- **CodeQL's fixes:** `check-breaking.test.mjs` gains the split comment and the escaped backslash, each mutation-checked; the contracts, db, stack and tools tests pass, as do lint and typecheck.
- **CI:** the PR's first run found CodeQL's 17 (above) and a lint error: the root `eslint tools` read the proof fixtures, which are now ignored.

## Implementation notes (PR B: the local hooks)

Built as H1–H3, with H2 amended by the owner on 2026-10-26 (below). No release: nothing here ships in an image.

**What runs where** (`lefthook.yml`, lefthook 2.2.2):

- **pre-commit:** `tools/hooks/gitleaks-staged.mjs` runs `gitleaks git --staged --redact` (gitleaks 8.30.1 replaced `protect --staged` with this). If `pnpm tools:gitleaks` hasn't been run, the commit is refused, saying so.
- **commit-msg:** `tools/hooks/commit-msg.mjs` holds the first line to G10 with `titleProblem` from `tools/security/pr-title.mjs`, CI's own PR-title check, so the two can't drift. Git's own messages pass: merges, reverts, `fixup!`, `squash!` and `amend!`.
- **pre-push**, in order, stopping at the first failure:
  - `turbo run typecheck --affected`, which builds what the affected packages import;
  - ESLint, with the workspace's one config, on the pushed files.
- **`pnpm tools:gitleaks`** (`tools/hooks/gitleaks.mjs`):
  - it fetches CI's gitleaks 8.30.1 into `.tools/`, which is git-ignored and outside every image's build context;
  - it checks the archive against the SHA-256 pinned for each platform before unpacking anything. The pins come from the release's published checksum list, whose `linux_x64` line is the one CI already pins.
  - On Windows it uses Windows' own `tar.exe`: under Git Bash, the `tar` on PATH is GNU tar, which reads neither zips nor a `C:` path.
- **Installing (H1):** `pnpm install`'s `prepare` runs `tools/hooks/install.mjs`, which installs the hooks except:
  - in CI;
  - outside a git checkout: the image builds run `pnpm install` with `.git` excluded, so a plain `lefthook install` would have failed all three;
  - where lefthook isn't installed.

  lefthook's own postinstall stays refused, and `pnpm-workspace.yaml` says so (`ignoredBuiltDependencies`).
- **CI** runs `tools/hooks/hooks.test.mjs` after the unit tests.

**The owner's amendment (2026-10-26).** As approved, a normal commit took 17–18 s on the owner's machine, against GC8's 10 s:
- ESLint took 10–11 s, most of it starting the typed config: 6.5 s even for a plain `.mjs` file;
- commitlint took 4–5 s: 3.6 s just to load.

The owner chose:
- **pre-commit:** gitleaks only. A secret is the one thing a later commit can't undo.
- **commit-msg:** G10's own code instead of commitlint, which also drops commitlint's 456 lockfile lines.
- **pre-push:** ESLint on the pushed files, beside the typecheck.

**Decisions made while building (for the owner's approval).**

1. **The hooks install through a script, not a bare `lefthook install`** (H1 said `prepare` runs `lefthook install`). The image builds run `pnpm install` without `.git`, where `lefthook install` fails, so `tools/hooks/install.mjs` skips there, in CI, and without lefthook, saying which.
2. **lefthook's postinstall is listed in `ignoredBuiltDependencies`:** the refusal H1 relies on is then written down, and pnpm stops warning about it on every install.
3. **`gitleaks git --staged`**, H2's `protect --staged` under the name gitleaks 8.30.1 gives it.
4. **The push checks run in order, typecheck first.** In parallel, ESLint's typed rules could run before the typecheck had built a package the file imports, and fail on unresolved types; this worktree showed exactly that, with 27 errors in `tools/stack/src/isolation.probe.ts` and `packages/db` unbuilt.
5. **`.tools/` is git-ignored and in `.dockerignore`,** so the fetched binary never enters a commit or an image's build context.

**Evidence.**

- **`node --test tools/hooks/hooks.test.mjs`:** 8 of 8 pass. **8 of 8 mutations caught:**
  - the three install skips;
  - the checksum comparison, and the refusal of a platform with no pin;
  - the commit message's G10 check, its comment-line skip, and git's own messages.
- **GC8, on a fresh clone of the branch** (Windows, Git Bash), where `pnpm install` alone installed the three hooks:

  | Case | Result |
  | --- | --- |
  | A commit without `pnpm tools:gitleaks` | refused, naming the command |
  | A normal commit | passes in 4.0, 2.4 and 2.6 s |
  | A planted fake GitHub token (random, never printed) | refused: `leaks found: 1` |
  | The message "update stuff" | refused: no type |
  | Git's own merge message | passes |
  | `--no-verify` with "update stuff" | commits |
  | A push with `any` in a domain file | refused: `no-explicit-any`, `no-unsafe-return` |
  | A push with a type error | refused: `TS2322` |
  | A clean push | passes |
| A push of a `tools/stack` file, with `packages/db`'s build removed | passes: the typecheck rebuilds it (4.7 s from turbo's cache), then ESLint lints the file (27 s) |

- **A push takes 19 to 105 s.** On this branch every package counts as affected, because the root `package.json` and lockfile changed, so the typecheck builds and checks all 12. The 105 s was the first run, with no turbo cache. A branch touching one package checks only what depends on it.
- **All 80 recent subjects on `main`** pass the commit-msg check, as they pass the PR-title check.
