# Spec 0024: CI security gates, and the local hooks

**Status:** **Proposed (2026-10-25),** for the owner's approval. G12 is decided (proprietary; CodeQL with no upload); G1–G11 and H1–H3 await approval. Nothing built yet.
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
| G6 | **The license policy.** These licenses are **allowed for production dependencies:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, Python-2.0 and Zlib.<br>**Refused:** GPL, AGPL, LGPL (for now), SSPL, BUSL, the Commons Clause, "UNLICENSED" and unknown.<br>The check reads `pnpm licenses list --prod --json` (pnpm's own command, no new dependency) for each app and package that ships. Its exceptions live in `infra/security/licenses.yaml`. | This is for **a proprietary, hosted product**: AGPL and SSPL would require releasing our own source, and GPL constrains distribution. **This depends on the owner's licensing intent: see G12.** Alternative: a third-party license checker. Rejected: pnpm's command already resolves the workspace's real graph. |
| G7 | **CodeQL runs read-only, with no upload.** `github/codeql-action` with `upload: never`, and the SARIF it writes is checked by our script (G3), so the job keeps `contents: read`, as CS12 requires. The results are attached to the run as an artifact. | Uploading to GitHub's code scanning needs `security-events: write`, which CS12 bans where PR code runs, for good reason. Alternative: allow that one permission on that one job, and amend CS12. That brings the "Security" tab's UI, and can come later as the owner's decision. |
| G8 | **Proofs, CS13's way.** Each gate must fail for its intended reason, with fixtures that never ship, in `tools/security/fixtures/`:<br>• **Semgrep:** a planted `eval` of request input;<br>• **osv-scanner:** a fixture lockfile with a known-vulnerable version;<br>• **the license check:** a fixture package with an AGPL license;<br>• **Checkov:** a Dockerfile running as root, and a workflow with `${{ github.event.pull_request.title }}` in `run:`;<br>• **CodeQL:** a tiny fixture database with a command injection;<br>• **the exceptions check:** an expired entry, and a reason missing.<br>The fast ones run every time; CodeQL's in its own job. | Without proofs, a misconfigured scanner looks exactly like a clean tree. Alternative: trust each tool's exit code. Rejected after CS13 found gates that passed for the wrong reason. |
| G9 | **Jobs and required checks.** Two new jobs:<br>• **`security-scans`:** the exceptions check first, then Semgrep, osv-scanner, the license check, Checkov and their proofs, and the PR-title check. In parallel with `build-test`, target under 5 minutes;<br>• **`codeql`:** in parallel, target under 15 minutes.<br>The owner adds both to `main`'s required checks. | Parallel jobs keep CI's critical path unchanged. Alternative: steps inside `build-test`, which is already about 20 minutes. Rejected. |
| G10 | **The PR title is checked as a Conventional Commit in CI**: `type(scope): description`, with the types `feat`, `fix`, `docs`, `test`, `build`, `ci`, `chore`, `refactor` and `perf`, and a scope required, lowercase. | The squash merge makes the title `main`'s commit message, so this is the gate that keeps history clean, whatever the local hooks did. Alternative: commitlint on every commit in the PR. Rejected: those commits disappear in the squash. |
| G11 | **Dependabot version updates for the GitHub Actions,** weekly (`.github/dependabot.yml`). The workflows say "Renovate bumps them", but no bot is configured. | Pinned SHAs go stale silently otherwise, missing security fixes to the actions. Security updates for npm already arrive (#100, #102). Alternative: Renovate. Rejected: one more app on the repo for the same job. |
| G12 | **Decided by the owner, 2026-10-25:**<br>• **the product is proprietary.** G6's policy stands as written: copyleft and source-available licenses are refused for production dependencies;<br>• **CodeQL runs, with no upload.** G7 stands as written: read-only, the SARIF checked by our script and kept as a run artifact. CS12 is unchanged. | The repository is public but has no license file, so it is "all rights reserved" by default, which matches. Stating that explicitly (a `LICENSE` saying so, and `"license": "UNLICENSED"` in the root `package.json`) is a small addition to PR A, for the owner to confirm. |

**PR B: the local hooks** (lefthook and commitlint, from docs/13 §2, with three changes):

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| H1 | **lefthook as a dev dependency, installed by `pnpm prepare` (`lefthook install`), with no postinstall script.** The workspace's `onlyBuiltDependencies` list stays as it is. lefthook ships its binary as a platform package, so nothing is downloaded at install time. | It keeps the "only these packages run install scripts" rule intact. Alternative: Husky. Rejected: it runs shell scripts, and lefthook's parallel, staged-file hooks are faster. |
| H2 | **pre-commit**, under 10 s:<br>• `eslint` on the staged files;<br>• `gitleaks protect --staged`, using a pinned, checksum-verified gitleaks fetched by `pnpm tools:gitleaks` (the same version and checksum as CI). It's never fetched unverified, and if it's absent the hook says how to get it, rather than skipping silently.<br>**commit-msg:** commitlint, with `@commitlint/config-conventional`, G10's types, and a scope required.<br>**pre-push:** `turbo run typecheck --affected`. | `tsc -b` moves from pre-commit (docs/13 §2) to pre-push: it can't stay under 10 s across the workspace. Alternative: pre-commit typecheck. Rejected for the 10-second budget. |
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
| GC8 | **PR B:** on a fresh clone, `pnpm install` installs the hooks, and:<br>• a commit with a lint error, a planted fake secret, or the message "update stuff" is refused;<br>• a push with a type error is refused;<br>• a normal commit passes in under 10 s;<br>• `--no-verify` still works: CI is the gate. |

## The owner's steps

1. **G12 is decided** (2026-10-25): proprietary, and CodeQL with no upload. Still to confirm: the explicit `LICENSE` and `"license": "UNLICENSED"` (G12).
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
