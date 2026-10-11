# Spec 0013: Container images — build, scan, SBOM, sign

**Status:** Draft, revision 2 (2026-10-11), for owner review before implementation. D1–D6 are recorded as the owner's decisions. Revision 2 corrects D4: zero HIGH/CRITICAL includes unfixed findings. It also tightens three criteria: real journeys inside the images, one artifact from test to signature, and every failure reaching its intended gate. Staging remains deferred.
**Phase:** 0 (roadmap exit criterion: "Images signed, 0 high/critical findings". [ADR-024](../19-decision-log.md): staging is deferred, but "image scanning and signing run in CI meanwhile").
**Builds on:**
- [docs/09 §2–3, §8](../09-container-security.md): image build rules, the scan → SBOM → sign → attest pipeline, the release-gate checklist;
- [docs/13 §3](../13-ci-cd-and-workflow.md): Trivy and image signing in the pipeline; actions pinned by SHA; least-privilege permissions;
- [docs/08](../08-security.md) T13: supply-chain attack (poisoned image).

Every AC ID appears in at least one test or CI step name.

## Why

The roadmap's Phase 0 exit needs signed images with no high or critical findings, and ADR-024 keeps that in force while staging is deferred. Today UniVarse builds **no images at all**: the API, worker and web app run only from source or `dist/`. Nothing proves that:
- what would be deployed is what CI tested;
- it contains no known vulnerabilities;
- it holds no secrets;
- it runs, with its real journeys, under the hardened runtime docs/09 requires.

This slice builds the images UniVarse owns and puts each one through the same steps: test it, scan it, record what's inside it, and sign it. **One artifact goes through every step.**

## What exists today (2026-10-11, `main` after #44)

- **No Dockerfiles.** docs/09 §2.2 has a reference `api.Dockerfile` on paper only.
- **The web app** isn't set to Next.js `output: 'standalone'`, which its image needs.
- **CI security:**
  - **In place:** gitleaks (checksum-verified) and `pnpm audit --audit-level high`. Actions are pinned by SHA, and the workflow is `contents: read`.
  - **Missing:** Trivy, osv-scanner, SBOM, registry push and signing.
- **CI's E2E** runs Playwright desktop and mobile through `tools/dev-edge` (edge → web → API → DB) against processes started from source and `dist/`, not images.
- **Third-party images** (Valkey, Mailpit, Vault, SeaweedFS, ClamAV, Gotenberg, the OTel Collector, Jaeger) are pinned by tag in the dev compose. docs/09 requires digests for production manifests.
- **The runtime contract the image must keep:**
  - the API and worker start with `node --import ./dist/otel.js` (spec 0012 OB9);
  - `/health/live` and `/health/ready` exist.

## Acceptance criteria

| ID | Criterion |
|---|---|
| CS1 | *The API image (`infra/docker/api.Dockerfile`), used for both API and worker.*<br>**Build rules (docs/09 §2.1):**<br>• multi-stage;<br>• runtime base `gcr.io/distroless/nodejs24-debian12:nonroot`, **pinned by digest** (D3);<br>• runs as **UID/GID 65532**, with `NODE_ENV=production`;<br>• OCI labels `source`, `revision`, `created`, `version`.<br>**One image, two commands:** `node --import ./dist/otel.js dist/main.js` and `… dist/worker.js`.<br>**Inspection of the built image:**<br>• its user is `65532:65532`;<br>• there's **no shell** (running `sh` fails);<br>• the file listing has no `.env*`, no `*.ts` source, no `*.spec.*`, no `dist/testing`, no `.git` and no `docs`;<br>• app files are root-owned and not writable by 65532. |
| CS2 | *The web image (`infra/docker/web.Dockerfile`).* Built with Next.js `output: 'standalone'`, under the same rules and the same inspection as CS1. |
| CS3 | *The base image is verified, not just pinned (D3).*<br>• **Before any build:** CI verifies the pinned distroless digest's **upstream signature** with cosign, against the distroless project's published keyless identity and issuer. A digest that fails verification fails the build.<br>• **Compatibility with the real application** is proved by CS4 and CS5 running on that base, not assumed. |
| CS4 | *Hardened runtime smoke test.* In CI, each image runs with:<br>• `--read-only`;<br>• `--user 65532:65532`;<br>• `--cap-drop ALL`;<br>• `--security-opt no-new-privileges`;<br>• a small `/tmp` tmpfs.<br>They run against the CI services (Postgres, Valkey, Mailpit, Vault, SeaweedFS, ClamAV).<br>**Each must:**<br>• **API:** answer `/health/live` and `/health/ready` with 200;<br>• **worker:** start and log `worker.started`;<br>• **web:** serve the login page with 200;<br>• **all:** write stdout as JSON lines only (spec 0012 OB1). |
| CS5 | *Real journeys inside the images.* The **containerised** API, worker and web (the CS4 runtime flags, the edge in front) run browser journeys with Playwright, desktop and mobile:<br>• **login** to the workspace;<br>• **login with MFA**: TOTP verify, and a recovery code;<br>• **step-up** on a protected action;<br>• **password reset**: the email is enqueued by the API container and delivered by the worker container, and the code is read from Mailpit;<br>• **upload → scan → download**: presigned upload to SeaweedFS, ClamAV scan by the worker container, authorised download through the API container.<br>**Why browser journeys and not just smoke checks:** they catch missing runtime files, native modules (`argon2`), Prisma, Next.js standalone packaging and static assets, which smoke checks don't.<br>**What the evidence names:** the image IDs that ran. |
| CS6 | *One artifact, end to end. Nothing is rebuilt between testing and signing.*<br>• **Build once:** each image is built **once** per run, and its image ID (config digest) is recorded.<br>• **Same image throughout:** CS1, CS4, CS5, the scan (CS7) and the SBOM (CS8) all run against that exact image ID.<br>• **Publish without rebuilding:** on `main`, publication **pushes that same image**. The job checks that the pushed manifest's config digest equals the tested image ID, so a rebuild or substitution fails the run. It then records the registry **manifest digest**.<br>• **Sign and verify that digest:** signing (CS10) and verification (CS11) target that manifest digest, and nothing else. |
| CS7 | *Vulnerability gate: zero HIGH/CRITICAL, fixed or not (D4).*<br>**The scan:**<br>• Trivy, version pinned, action pinned by SHA;<br>• vulnerability DB fetched fresh each run;<br>• scans each image ID from CS6.<br>**The check fails on any HIGH or CRITICAL finding, whether or not a fix exists.** `--ignore-unfixed` and `ignore-unfixed` are **not** used; a CI check fails if either appears in the workflow or the Trivy config.<br>**Exceptions** live only in `.trivyignore.yaml`. Each entry must name:<br>• the specific **finding ID** and **package**;<br>• **evidence** (why it doesn't apply, or what mitigates it);<br>• an **owner**;<br>• an **expiry** of at most 30 days.<br>An entry missing any of these, or past its expiry, fails the check. Every active exception is listed in the job summary.<br>**An active exception keeps the risk visible.** While any exists, the roadmap's "0 high/critical findings" exit **can't be claimed**, and the completion record must say so.<br>**The same run also performs:** Trivy's **secret** scan of the image layers, and its **misconfiguration** scan of the Dockerfiles. |
| CS8 | *SBOM and provenance.*<br>• **SBOM:** SPDX JSON per image, generated **from the built image** (not the lockfile). On PRs it's a workflow artifact; on `main` it's also attached to the published digest as a signed attestation.<br>• **Provenance:** SLSA build provenance for each published digest, via GitHub artifact attestations. |
| CS9 | *Fail closed.* Publication happens only after every gate has **passed**, so any of these blocks it:<br>• the scanner can't run;<br>• the vulnerability DB can't be fetched;<br>• the SBOM can't be produced;<br>• base-image verification fails.<br>A skipped, errored or timed-out gate counts as a failure, never as "no findings". |
| CS10 | *Push and sign, `main` only (D1, D2).* After CS1–CS9 pass on a push to `main`:<br>• push each tested image to **private** GHCR packages (D1), by digest;<br>• sign the digest **keylessly** with cosign, using the workflow's OIDC token (issuer `https://token.actions.githubusercontent.com`);<br>• attach the SBOM and provenance attestations.<br>Tags (`sha-<short>`) are for humans; the job summary records the digests. |
| CS11 | *Verification pinned to the exact signer (D2).* A follow-on step verifies each published digest with `cosign verify`, requiring all of:<br>• **certificate identity** exactly `https://github.com/w1t3ack3r/univarse/.github/workflows/ci.yml@refs/heads/main`;<br>• **OIDC issuer** exactly `https://token.actions.githubusercontent.com`.<br>Any other valid signature is **not** accepted. The **provenance and SBOM attestations** are verified too (`gh attestation verify`, pinned to this repository and signer workflow, checking each predicate type). |
| CS12 | *Least privilege, and untrusted PR code never runs with privileges.*<br>**Triggers:**<br>• **PR builds:** they run only on `pull_request`. Today `ci` and `api-contract` use `pull_request` only (checked 2026-10-11).<br>• **Privileged triggers:** a `pull_request_target` or `workflow_run` job must **never** check out, build or execute PR code. GitHub's ordinary fork restrictions don't cover those triggers: they run with the base repository's token and secrets. This slice adds neither.<br>**Permissions:**<br>• the build, test and scan job has `contents: read` only;<br>• no job reachable from `pull_request` has `packages: write`, `id-token: write` or `attestations: write`;<br>• those permissions exist only on the publish job, which runs only on `push` to `refs/heads/main`.<br>**Evidence: policy verification; no live fork test.** A workflow-policy check, run in CI, fails if:<br>• a job reachable from `pull_request` requests those permissions or references publish credentials;<br>• any workflow uses `pull_request_target` or `workflow_run` together with a checkout of the PR's head, or runs PR-supplied code.<br>Each PR run's summary also records that publishing and signing were not attempted. **A live fork PR test was not performed** (see Design notes). |
| CS13 | *Every gate fails for its intended reason* (throwaway PRs closed unmerged, as #35 and #43; run IDs recorded). Each mutation must fail at **its** gate, with the expected message, and publication must not run.<br>**Image content (CS1):**<br>• an image running as **root**: the user check fails;<br>• an image containing a **shell**: the shell check fails;<br>• a **secret-shaped file** baked into the image, with its value built at run time and never committed: the secret scan fails.<br>**Vulnerabilities (CS7):**<br>• a known **fixable** HIGH/CRITICAL: the scan fails, naming it;<br>• a known **unfixed** HIGH/CRITICAL: the scan fails, naming it, which proves unfixed findings aren't ignored;<br>• an **expired** exception: the exception check fails;<br>• an exception **missing evidence or owner**: the exception check fails;<br>• `ignore-unfixed` added to the config: the policy check fails.<br>**Fail-closed and artifact consistency (CS9, CS6):**<br>• the **vulnerability DB unreachable**: the scan step errors, and the publish job doesn't run;<br>• the image **rebuilt** before publish (a substituted image): the CS6 consistency check fails.<br>**Signer identity (CS11), as negative steps expected to fail inside the verify job:**<br>• `cosign verify` with the **wrong identity** (another workflow or branch);<br>• an **unsigned** digest.<br>**Least privilege (CS12):**<br>• a PR job **requesting `id-token: write`**: the workflow-policy check fails;<br>• a workflow on **`pull_request_target`** (or `workflow_run`) that checks out the PR's head: the workflow-policy check fails. |
| CS14 | *Retention (D6).*<br>• **This slice deletes nothing:** there are no deployments yet, and Container Registry storage is free.<br>• **The policy is written down for when cleanup is built:** keep the newest **20 eligible, unused** versions per image. Never delete versions that are deployed or kept for rollback, or **their signatures and attestations**. "Untagged" alone doesn't make a version eligible, because cosign signatures and attestations are stored as separate artifacts that look untagged. |
| CS15 | *Required check.* Once CS1–CS13 are green, the PR-side job (e.g. `image-scan`) becomes a required status check in the `protect-main` ruleset, alongside `build-test`, `secrets-scan` and `api-breaking-changes`. |
| CS16 | *Evidence.* The completion record holds:<br>• latest-commit run IDs for the PR build/test/scan, the `main` publish, and verify;<br>• each CS13 proof with the gate and message it failed on;<br>• the tested image IDs and published manifest digests (showing CS6 held);<br>• image sizes;<br>• Trivy counts by severity, fixed and unfixed;<br>• any active exceptions;<br>• SBOM component counts.<br>The record states **explicitly** whether the roadmap's zero-findings exit is met. |

## Design notes

- **One API image, two commands** (docs/09 §2.1 rule 10): the worker is the same build with `dist/worker.js`. The `--import ./dist/otel.js` preload stays in both commands, so tracing still loads first.
- **Build in CI, not on the laptop:** the 8 GB machine is memory-starved (spec 0012 local E2E record). Local image builds stay possible but optional; CI is the evidence.
- **One build, saved and reused (CS6):** the image is built once with `docker buildx … --load`, and its image ID is captured. Tests and scans use that ID.
  - **Same job:** publication pushes the loaded image.
  - **Across jobs:** the image is passed as a `docker save` artifact, and its ID is re-checked after `docker load`.
  - **Before signing:** the pushed manifest's config digest is compared with the tested ID.
- **pnpm deploy** produces a pruned production `node_modules` for `@univarse/api`. Native dependencies (`argon2`) are built in a Debian bookworm stage, so they match the distroless Debian 12 runtime's glibc. CS5 proves it at run time.
- **Prisma 7** uses the TypeScript query compiler with the `pg` driver adapter, so no engine binary has to ship. CS5's journeys exercise the DB path in the image.
- **Next.js standalone** output changes only the build output; `next dev` is unaffected. CS5 covers static assets and server rendering from the image.
- **Containerised journeys reuse the existing E2E suite:**
  - The edge (`tools/dev-edge`) routes to the containers instead of local processes.
  - On the Linux runner, the containers use `--network host`, so `127.0.0.1` reaches CI's services. They get only the environment the app needs.
  - Source-mode E2E stays as it is.
- **Private packages and verification:** verifying private GHCR images needs a registry login, with read permission, inside the verify job. The public Sigstore log still records the signing identity and digest (D2).
- **Fork PRs:** GitHub gives `pull_request` runs from forks a read-only token and no secrets. That protection covers `pull_request` only, which is why CS12 also bans privileged triggers (`pull_request_target`, `workflow_run`) from touching PR code.
  - **Label of the evidence:** CS12's evidence is **policy verification**. **A live fork test was not performed.**
  - **If one is wanted later:** a fork PR could come from an organization the owner controls; a second personal account isn't required. It's not planned for this slice.

## Decisions (owner, 2026-10-11)

| # | Decision |
|---|---|
| D1 | **Registry: GHCR, private packages initially.** Pushed only from `main` with the workflow's `GITHUB_TOKEN`; no new account or long-lived credential. GitHub currently lists Container Registry storage and bandwidth as free, which differs from its general Packages allowances. Changing visibility is the owner's action, not this slice's. |
| D2 | **Keyless cosign plus GitHub artifact attestations.** Verification requires the exact repository, workflow, `refs/heads/main` and the OIDC issuer `https://token.actions.githubusercontent.com`, never "any valid signature". The provenance and SBOM attestations are verified as well (CS11). |
| D3 | **`gcr.io/distroless/nodejs24-debian12:nonroot`, digest-pinned.** Its upstream signature is verified (CS3), and its compatibility is proved by the real journeys (CS5). |
| D4 | **Block all HIGH/CRITICAL findings by default, fixed or unfixed.** `ignore-unfixed` is not the gate.<br>• **Exceptions** need the specific finding and package, evidence, an owner and an expiry.<br>• **Visibility:** an accepted unresolved risk stays visible, and while it exists the roadmap's zero-findings exit can't be claimed (CS7, CS16). |
| D5 | **Our two application images** (API/worker and web) for this slice. Scanning the **third-party images** stays **explicitly pending before staging**. |
| D6 | **Retention: the newest 20 eligible, unused versions per image.** Deployed and rollback versions, and their signatures and attestations, are protected. Being untagged doesn't make a version eligible. This slice records the policy and deletes nothing (CS14). |

## Docs to update in the same change

- **docs/09:**
  - **§2.2:** the real Dockerfiles replace the reference one.
  - **§3:** the pipeline as built: one artifact from test to signature, fail-closed gates, the exact verify identity, how to verify.
  - **§8:** the checklist items this slice closes, with zero-findings stated honestly.
- **docs/13 §3:** the image jobs, their permissions, the workflow-policy check, and the required check.
- **docs/19:** an ADR for registry, signing and the findings policy (D1, D2, D4).
- **docs/18 Phase 0:** whether "Images signed, 0 high/critical findings" is met in CI, with the evidence. It isn't met while any exception is active. Staging's criteria stay deferred.
- **README:** a status row, and how to verify an image (`cosign verify …` with the exact identity, `gh attestation verify …`).

## Out of scope (tracked)

| Item | Where |
|---|---|
| **Third-party images:** scanning, digest pinning in deploy manifests | **Pending before staging** (D5, ADR-024) |
| Registry cleanup automation | CS14's policy; built with staging and deployments |
| Nightly re-scan of published digests, with issues filed automatically | docs/09 §3, after staging |
| Admission control requiring signed images (Kyverno) | docs/09 §4.1, Phase 8 / production |
| Renovate for base digests and actions | docs/09 §1 |
| `osv-scanner`, license check and `pnpm audit signatures` in CI | docs/09 §1; a separate dependency-scanning slice |
| Clean local E2E run (spec 0012: cause measured) | Pending separately |
| Product cache across instances (spec 0003 P7), `GET /users` pagination, key-forget broadcast, shred ledger | Unchanged: still open |
