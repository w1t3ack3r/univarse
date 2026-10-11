# Spec 0013: Container images — build, scan, SBOM, sign

**Status:** Draft, revision 3 (2026-10-11), for owner review before implementation. D1–D6 are recorded as the owner's decisions.
- **Revision 2:** corrected D4 (zero HIGH/CRITICAL includes unfixed findings), and tightened three criteria: real journeys inside the images, one artifact from test to signature, and every failure reaching its intended gate.
- **Revision 3:**
  - the maintained Debian 13 base, with its digest resolved;
  - no native `argon2`;
  - permission and trigger mutations as fixture data;
  - narrower inspection and logging wording;
  - explicit secret and misconfiguration gates, with canary-proved coverage;
  - CS12's trigger wording.

Staging remains deferred.
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
| CS1 | *The API image (`infra/docker/api.Dockerfile`), used for both API and worker.*<br>**Build rules (docs/09 §2.1):**<br>• multi-stage;<br>• runtime base `gcr.io/distroless/nodejs24-debian13:nonroot`, **pinned by digest** (D3; resolved 2026-10-11 as `sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e`);<br>• runs as **UID/GID 65532**, with `NODE_ENV=production`;<br>• OCI labels `source`, `revision`, `created`, `version`.<br>**One image, two commands:** `node --import ./dist/otel.js dist/main.js` and `… dist/worker.js`.<br>**Inspection of the built image:**<br>• its user is `65532:65532`;<br>• there's **no shell** (running `sh` fails);<br>• the file listing contains none of **UniVarse's own** source and test files: no `apps/*/src`, `packages/*/src`, `*.spec.*`, `*.int.spec.*`, `e2e/`, `dist/testing`, `.env*`, `.git` or `docs`;
• **dependency files stay:** a third-party package's `.d.ts` or other shipped files are allowed. The check targets our paths, not every `*.ts`, so needed dependency files aren't stripped just to pass inspection;<br>• app files are root-owned and not writable by 65532. |
| CS2 | *The web image (`infra/docker/web.Dockerfile`).* Built with Next.js `output: 'standalone'`, under the same rules and the same inspection as CS1. |
| CS3 | *The base image is verified, not just pinned (D3).*<br>• **The digest:** `gcr.io/distroless/nodejs24-debian13:nonroot` resolved on 2026-10-11 to the multi-arch index `sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e`, which includes `linux/amd64` and `linux/arm64/v8`. The Debian 12 variant is no longer the supported listing.
• **Before any build:** CI verifies that digest's **upstream signature** with cosign, against the distroless project's published keyless identity and issuer. A digest that fails verification fails the build. This hasn't been verified locally: cosign isn't installed on the dev machine, and verification is CI's first image step.<br>• **Compatibility with the real application** is proved by CS4 and CS5 running on that base, not assumed. |
| CS4 | *Hardened runtime smoke test.* In CI, each image runs with:<br>• `--read-only`;<br>• `--user 65532:65532`;<br>• `--cap-drop ALL`;<br>• `--security-opt no-new-privileges`;<br>• a small `/tmp` tmpfs.<br>They run against the CI services (Postgres, Valkey, Mailpit, Vault, SeaweedFS, ClamAV).<br>**Each must:**<br>• **API:** answer `/health/live` and `/health/ready` with 200;<br>• **worker:** start and log `worker.started`;<br>• **web:** serve the login page with 200;<br>• **API and worker:** write stdout as JSON lines only (spec 0012 OB1). The web image isn't held to this; structured logging for Next.js is separate work. |
| CS5 | *Real journeys inside the images.* The **containerised** API, worker and web (the CS4 runtime flags, the edge in front) run browser journeys with Playwright, desktop and mobile:<br>• **login** to the workspace;<br>• **login with MFA**: TOTP verify, and a recovery code;<br>• **step-up** on a protected action;<br>• **password reset**: the email is enqueued by the API container and delivered by the worker container, and the code is read from Mailpit;<br>• **upload → scan → download**: presigned upload to SeaweedFS, ClamAV scan by the worker container, authorised download through the API container.<br>**Why browser journeys and not just smoke checks:** they catch missing runtime files, the Node built-ins the app relies on (`crypto.argon2()` needs Node ≥ 24.7; ADR-016), Prisma, Next.js standalone packaging and static assets, which smoke checks don't.<br>**What the evidence names:** the image IDs that ran. |
| CS6 | *One artifact, end to end. Nothing is rebuilt between testing and signing.*<br>• **Build once:** each image is built **once** per run, and its image ID (config digest) is recorded.<br>• **Same image throughout:** CS1, CS4, CS5, the scan (CS7) and the SBOM (CS8) all run against that exact image ID.<br>• **Publish without rebuilding:** on `main`, publication **pushes that same image**. The job checks that the pushed manifest's config digest equals the tested image ID, so a rebuild or substitution fails the run. It then records the registry **manifest digest**.<br>• **Sign and verify that digest:** signing (CS10) and verification (CS11) target that manifest digest, and nothing else. |
| CS7 | *Vulnerability gate: zero HIGH/CRITICAL, fixed or not (D4).*<br>**The scan:**<br>• Trivy, version pinned, action pinned by SHA;<br>• vulnerability DB fetched fresh each run;<br>• scans each image ID from CS6.<br>**The check fails on any HIGH or CRITICAL finding, whether or not a fix exists.** `--ignore-unfixed` and `ignore-unfixed` are **not** used; a CI check fails if either appears in the workflow or the Trivy config.<br>**Exceptions** live only in `.trivyignore.yaml`. Each entry must name:<br>• the specific **finding ID** and **package**;<br>• **evidence** (why it doesn't apply, or what mitigates it);<br>• an **owner**;<br>• an **expiry** of at most 30 days.<br>An entry missing any of these, or past its expiry, fails the check. Every active exception is listed in the job summary.<br>**An active exception keeps the risk visible.** While any exists, the roadmap's "0 high/critical findings" exit **can't be claimed**, and the completion record must say so.<br>**Secret gate. Any secret finding blocks publication, at any severity.**<br>• **Filesystem:** the scan covers every layer's files, **including `node_modules`**. Trivy's secret scanner skips `node_modules` by default, and deployed workspace packages live there (e.g. `/app/node_modules/@univarse/*` after `pnpm deploy`). The real image layout is listed first; then coverage is configured to include those paths (by adjusting the built-in allow rules, or by scanning the exported root filesystem), and nothing is excluded without a recorded reason.<br>• **Image metadata:** the **image configuration and history** are scanned too (Trivy `--image-config-scanners secret`): environment variables, labels and build-step history.<br>• **Exceptions:** the same rules as vulnerabilities (finding, path, evidence, owner, expiry). A false positive in a dependency is excepted by **exact path and rule**, never by skipping a directory.<br>**Misconfiguration gate:** Trivy's scan of the Dockerfiles (and the image configuration) **blocks on HIGH or CRITICAL**, with the same exception rules. MEDIUM and LOW are listed in the summary.<br>**Coverage is proved with harmless canaries** (CS13): secret-shaped values built at run time, never committed, matching a Trivy rule, placed where the promise reaches. |
| CS8 | *SBOM and provenance.*<br>• **SBOM:** SPDX JSON per image, generated **from the built image** (not the lockfile). On PRs it's a workflow artifact; on `main` it's also attached to the published digest as a signed attestation.<br>• **Provenance:** SLSA build provenance for each published digest, via GitHub artifact attestations. |
| CS9 | *Fail closed.* Publication happens only after every gate has **passed**, so any of these blocks it:<br>• the scanner can't run;<br>• the vulnerability DB can't be fetched;<br>• the SBOM can't be produced;<br>• base-image verification fails.<br>A skipped, errored or timed-out gate counts as a failure, never as "no findings". |
| CS10 | *Push and sign, `main` only (D1, D2).* After CS1–CS9 pass on a push to `main`:<br>• push each tested image to **private** GHCR packages (D1), by digest;<br>• sign the digest **keylessly** with cosign, using the workflow's OIDC token (issuer `https://token.actions.githubusercontent.com`);<br>• attach the SBOM and provenance attestations.<br>Tags (`sha-<short>`) are for humans; the job summary records the digests. |
| CS11 | *Verification pinned to the exact signer (D2).* A follow-on step verifies each published digest with `cosign verify`, requiring all of:<br>• **certificate identity** exactly `https://github.com/w1t3ack3r/univarse/.github/workflows/ci.yml@refs/heads/main`;<br>• **OIDC issuer** exactly `https://token.actions.githubusercontent.com`.<br>Any other valid signature is **not** accepted. The **provenance and SBOM attestations** are verified too (`gh attestation verify`, pinned to this repository and signer workflow, checking each predicate type). |
| CS12 | *Least privilege, and untrusted PR code never runs with privileges.*<br>**Triggers:**<br>• **PR builds:** PR runs use only the `pull_request` trigger. `ci.yml` runs on `pull_request` and on `push` to `main`; `api-contract.yml` runs on `pull_request` (checked 2026-10-11).<br>• **Privileged triggers:** a `pull_request_target` or `workflow_run` job must **never** check out, build or execute PR code. GitHub's ordinary fork restrictions don't cover those triggers: they run with the base repository's token and secrets. This slice adds neither.<br>**Permissions:**<br>• the build, test and scan job has `contents: read` only;<br>• no job reachable from `pull_request` has `packages: write`, `id-token: write` or `attestations: write`;<br>• those permissions exist only on the publish job, which runs only on `push` to `refs/heads/main`.<br>**Evidence: policy verification; no live fork test.** A workflow-policy check runs as a **read-only** test (no permissions beyond `contents: read`) over the repository's real workflow files. It fails if:<br>• a job reachable from `pull_request` requests those permissions or references publish credentials;<br>• any workflow uses `pull_request_target` or `workflow_run` together with a checkout of the PR's head, or runs PR-supplied code.<br>Each PR run's summary also records that publishing and signing were not attempted. **A live fork PR test was not performed** (see Design notes). |
| CS13 | *Every gate fails for its intended reason* (throwaway PRs closed unmerged, as #35 and #43; run IDs recorded). Each mutation must fail at **its** gate, with the expected message, and publication must not run.<br>**Image content (CS1):**<br>• an image running as **root**: the user check fails;<br>• an image containing a **shell**: the shell check fails;<br>• **secret canaries**, each a harmless value built at run time and never committed, each expected to be found by the secret gate:<br>&nbsp;&nbsp;– in an app file under `/app`;<br>&nbsp;&nbsp;– inside a deployed workspace package under `node_modules/@univarse/…`, proving `node_modules` is covered;<br>&nbsp;&nbsp;– in an image **environment variable or label** (configuration);<br>&nbsp;&nbsp;– in a **build step** recorded in the image history.<br>&nbsp;&nbsp;Each must be reported at its location. A canary that isn't found fails the proof: the coverage claim isn't met.<br>**Vulnerabilities (CS7):**<br>• a known **fixable** HIGH/CRITICAL: the scan fails, naming it;<br>• a known **unfixed** HIGH/CRITICAL: the scan fails, naming it, which proves unfixed findings aren't ignored;<br>• an **expired** exception: the exception check fails;<br>• an exception **missing evidence or owner**: the exception check fails;<br>• `ignore-unfixed` added to the config: the policy check fails.<br>**Fail-closed and artifact consistency (CS9, CS6):**<br>• the **vulnerability DB unreachable**: the scan step errors, and the publish job doesn't run;<br>• the image **rebuilt** before publish (a substituted image): the CS6 consistency check fails.<br>**Signer identity (CS11), as negative steps expected to fail inside the verify job:**<br>• `cosign verify` with the **wrong identity** (another workflow or branch);<br>• an **unsigned** digest.<br>**Least privilege (CS12): fixtures, never executable workflows.** These are **workflow definitions stored as test fixture data** (for example under `tools/ci-policy/fixtures/`, outside `.github/workflows/`), so GitHub never runs them. The read-only policy test loads each fixture and must reject it with the expected message:<br>• a `pull_request` job requesting `id-token: write`, `packages: write` or `attestations: write`;<br>• a `pull_request_target` or `workflow_run` workflow that checks out the PR's head, or runs PR-supplied code;<br>• a PR-reachable job that references the publish credentials.<br>**Why fixtures:** a failing policy check doesn't stop another privileged job in the same PR from starting first, and GitHub warns against privileged workflows running untrusted PR code. So no proof PR adds a real job with signing permissions, or a real privileged trigger.<br>**Positive control:** the real workflow files must **pass** the same test. |
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
- **pnpm deploy** produces a pruned production `node_modules` for `@univarse/api`.
  - **No native `argon2`:** password hashing uses Node's built-in `crypto.argon2()` ([ADR-016](../19-decision-log.md)), so nothing native is compiled for it. ADR-016 also asks images to **pin the Node minor**; the digest pin does that, and the evidence records the Node version in the image.
  - **Builder stage:** a Debian 13 (trixie) Node 24 image, matching the runtime's Debian 13 glibc, so any dependency that ships platform binaries resolves for the same platform. Prisma 7 needs no engine binary (below). CS5 proves it at run time.
  - **A stale entry:** `pnpm-workspace.yaml`'s `onlyBuiltDependencies` still lists `argon2`, though no package depends on it. Removing it is a small separate cleanup, noted here.
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
| D3 | **`gcr.io/distroless/nodejs24-debian13:nonroot`, digest-pinned** (the maintained, supported listing; Debian 12 is superseded). Its upstream signature is verified (CS3), and its compatibility is proved by the real journeys (CS5). |
| D4 | **Block all HIGH/CRITICAL findings by default, fixed or unfixed.** `ignore-unfixed` is not the gate.<br>• **Exceptions** need the specific finding and package, evidence, an owner and an expiry.<br>• **Visibility:** an accepted unresolved risk stays visible, and while it exists the roadmap's zero-findings exit can't be claimed (CS7, CS16). |
| D5 | **Our two application images** (API/worker and web) for this slice. Scanning the **third-party images** stays **explicitly pending before staging**. |
| D6 | **Retention: the newest 20 eligible, unused versions per image.** Deployed and rollback versions, and their signatures and attestations, are protected. Being untagged doesn't make a version eligible. This slice records the policy and deletes nothing (CS14). |

## Docs to update in the same change

- **docs/09:**
  - **§2.1 rule 2 and §2.2:** the runtime base becomes `gcr.io/distroless/nodejs24-debian13:nonroot`, and the builder Debian 13. The real Dockerfiles replace the reference one. Done in this revision: docs/09 now names Debian 13 for both the builder and the runtime, and §1 no longer lists `argon2`.
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
