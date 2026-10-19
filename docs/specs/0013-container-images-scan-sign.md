# Spec 0013: Container images — build, scan, SBOM, sign

**Status:** **Closed (2026-10-13)** for its implemented scope: CS1–CS9, CS12, CS13, LR1–LR8, LR10 and LR9's verifier are met (see the CS16 record). LR9's deploy integration ("nothing from a rejected record runs") is **transferred** to the local-deploy work as a blocking acceptance criterion: the deploy holds the registry lock throughout verification and startup, and verifies before starting any container.

Accepted (2026-10-11), owner review of revision 3 (`ee3590f`). D1–D6 decided, with the conditions written into the criteria; the registry, signing and findings decisions are recorded as ADR-029. At acceptance, CS3 (verification of the base image's upstream signature) was pending until it passed in CI; it has passed since #49. Implementation starts with the image-build slice.

**Amended 2026-10-12 by [ADR-030](../19-decision-log.md) (fully local):**
- **Registry and signing:** CS10/CS11 publish to a **local registry** (`127.0.0.1` only) and sign with a **local cosign key** (private key encrypted, outside the repository; public key committed). Verification is pinned to that key, and the attestations are signed with it.
- **CI publishes nothing.**
- **D1 and D2 are superseded** as described; D3–D6 stand.
- **Steps 1–3 are done in CI** (#49–#51: CS1–CS9).
- **Still to do:** the local publication step, then CS12–CS16.
- **Rewritten in the local step:** CS12's permission split (there's no CI publish job any more) and CS15's required check.
- **Revision 2:** corrected D4 (zero HIGH/CRITICAL includes unfixed findings), and tightened three criteria: real journeys inside the images, one artifact from test to signature, and every failure reaching its intended gate.
- **Revision 3:**
  - the maintained Debian 13 base, with its digest resolved;
  - no native `argon2`;
  - permission and trigger mutations as fixture data;
  - narrower inspection and logging wording;
  - explicit secret and misconfiguration gates, with canary-proved coverage;
  - CS12's trigger wording.

Staging is paused: everything is local ([ADR-030](../19-decision-log.md)).

**Phase:** 0 (roadmap exit criterion: "Images signed, 0 high/critical findings". [ADR-030](../19-decision-log.md): fully local. Images are built and gated in CI and in the local release, and signed and verified **locally**.)
**Builds on:**
- [docs/09 §2–3, §8](../09-container-security.md): image build rules, the scan → SBOM → sign → attest pipeline, the release-gate checklist;
- [docs/13 §3](../13-ci-cd-and-workflow.md): Trivy and image signing in the pipeline; actions pinned by SHA; least-privilege permissions;
- [docs/08](../08-security.md) T13: supply-chain attack (poisoned image).

Every AC ID appears in at least one test or CI step name.

## Why

The roadmap's Phase 0 exit needs signed images with no high or critical findings, and ADR-030 keeps it, met on the developer machine. Today UniVarse builds **no images at all**: the API, worker and web app run only from source or `dist/`. Nothing proves that:
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
| CS1 | *The API image (`infra/docker/api.Dockerfile`), used for both API and worker.*<br>**Build rules (docs/09 §2.1):**<br>• multi-stage;<br>• runtime base `gcr.io/distroless/nodejs24-debian13:nonroot`, **pinned by digest** (D3; resolved 2026-10-11 as `sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e`);<br>• runs as **UID/GID 65532**, with `NODE_ENV=production`;<br>• OCI labels `source`, `revision`, `created`, `version`.<br>**One image, two commands:** `node --import ./dist/otel.js dist/main.js` and `… dist/worker.js`.<br>**Inspection of the built image:**<br>• its user is `65532:65532`;<br>• there's **no shell** (running `sh` fails);<br>• the file listing contains none of **UniVarse's own** source and test files: no `apps/*/src`, `packages/*/src`, `*.spec.*`, `*.int.spec.*`, `e2e/`, `dist/testing`, `.env*`, `.git` or `docs`;<br>• **dependency files stay:** a third-party package's `.d.ts` or other shipped files are allowed. The check targets our paths, not every `*.ts`, so needed dependency files aren't stripped just to pass inspection;<br>• app files are root-owned and not writable by 65532. |
| CS2 | *The web image (`infra/docker/web.Dockerfile`).* Built with Next.js `output: 'standalone'`, under the same rules and the same inspection as CS1. |
| CS3 | *The base image is verified, not just pinned (D3).*<br>• **The digest:** `gcr.io/distroless/nodejs24-debian13:nonroot` resolved on 2026-10-11 to the multi-arch index `sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e`, which includes `linux/amd64` and `linux/arm64/v8`. The Debian 12 variant is no longer the supported listing.<br>• **Before any build:** CI verifies that digest's **upstream signature** with cosign, against the distroless project's published keyless identity and issuer. A digest that fails verification fails the build. This hasn't been verified locally: cosign isn't installed on the dev machine, and verification is CI's first image step.<br>• **Compatibility with the real application** is proved by CS4 and CS5 running on that base, not assumed. |
| CS4 | *Hardened runtime smoke test.* In CI, each image runs with:<br>• `--read-only`;<br>• `--user 65532:65532`;<br>• `--cap-drop ALL`;<br>• `--security-opt no-new-privileges`;<br>• a small `/tmp` tmpfs.<br>They run against the CI services (Postgres, Valkey, Mailpit, Vault, SeaweedFS, ClamAV).<br>**Each must:**<br>• **API:** answer `/health/live` and `/health/ready` with 200;<br>• **worker:** start and log `worker.started`;<br>• **web:** serve the login page with 200;<br>• **API and worker:** write stdout as JSON lines only (spec 0012 OB1). The web image isn't held to this; structured logging for Next.js is separate work. |
| CS5 | *Real journeys inside the images.* The **containerised** API, worker and web (the CS4 runtime flags, the edge in front) run browser journeys with Playwright, desktop and mobile:<br>• **login** to the workspace;<br>• **login with MFA**: TOTP verify, and a recovery code;<br>• **step-up** on a protected action;<br>• **password reset**: the email is enqueued by the API container and delivered by the worker container, and the code is read from Mailpit;<br>• **upload → scan → download**: presigned upload to SeaweedFS, ClamAV scan by the worker container, authorised download through the API container.<br>**Why browser journeys and not just smoke checks:** they catch missing runtime files, the Node built-ins the app relies on (`crypto.argon2()` needs Node ≥ 24.7; ADR-016), Prisma, Next.js standalone packaging and static assets, which smoke checks don't.<br>**What the evidence names:** the image IDs that ran. |
| CS6 | *One artifact, end to end. Nothing is rebuilt between testing and signing.*<br>• **Build once:** each image is built **once** per run, and its image ID (config digest) is recorded.<br>• **Same image throughout:** CS1, CS4, CS5, the scan (CS7) and the SBOM (CS8) all run against that exact image ID.<br>• **Publish without rebuilding:** on `main`, publication **pushes that same image**. The job checks that the pushed manifest's config digest equals the tested image ID, so a rebuild or substitution fails the run. It then records the registry **manifest digest**.<br>• **Sign and verify that digest:** signing (CS10) and verification (CS11) target that manifest digest, and nothing else. |
| CS7 | *Vulnerability gate: zero HIGH/CRITICAL, fixed or not (D4).*<br>**The scan:**<br>• Trivy, version pinned, action pinned by SHA;<br>• vulnerability DB fetched fresh each run;<br>• scans each image ID from CS6.<br>**The check fails on any HIGH or CRITICAL finding, whether or not a fix exists.** `--ignore-unfixed` and `ignore-unfixed` are **not** used; a CI check fails if either appears in the workflow or the Trivy config.<br>**Exceptions** live only in `.trivyignore.yaml`. Each entry must name:<br>• the specific **finding ID** and **package**;<br>• **evidence** (why it doesn't apply, or what mitigates it);<br>• an **owner**;<br>• an **expiry** of at most 30 days.<br>An entry missing any of these, or past its expiry, fails the check. Every active exception is listed in the job summary.<br>**An active exception keeps the risk visible.** While any exists, the roadmap's "0 high/critical findings" exit **can't be claimed**, and the completion record must say so.<br>**Secret gate. Any secret finding blocks publication, at any severity.**<br>• **Filesystem:** the scan covers every layer's files, **including `node_modules`**. Trivy's secret scanner skips `node_modules` by default, and deployed workspace packages live there (e.g. `/app/node_modules/@univarse/*` after `pnpm deploy`). The real image layout is listed first; then coverage is configured to include those paths (by adjusting the built-in allow rules, or by scanning the exported root filesystem), and nothing is excluded without a recorded reason.<br>• **Image metadata:** the **image configuration and history** are scanned too (Trivy `--image-config-scanners secret`): environment variables, labels and build-step history.<br>• **Exceptions:** the same rules as vulnerabilities (finding, path, evidence, owner, expiry). A false positive in a dependency is excepted by **exact path and rule**, never by skipping a directory.<br>**Misconfiguration gate:** Trivy's scan of the Dockerfiles (and the image configuration) **blocks on HIGH or CRITICAL**, with the same exception rules. MEDIUM and LOW are listed in the summary.<br>**Coverage is proved with harmless canaries** (CS13): secret-shaped values built at run time, never committed, matching a Trivy rule, placed where the promise reaches. |
| CS8 | *SBOM and provenance.*<br>• **SBOM:** SPDX JSON per image, generated **from the built image** (not the lockfile). On PRs it's a workflow artifact; on `main` it's also attached to the published digest as a signed attestation.<br>• **Provenance:** SLSA build provenance for each published digest, via GitHub artifact attestations. |
| CS9 | *Fail closed.* Publication happens only after every gate has **passed**, so any of these blocks it:<br>• the scanner can't run;<br>• the vulnerability DB can't be fetched;<br>• the SBOM can't be produced;<br>• base-image verification fails.<br>A skipped, errored or timed-out gate counts as a failure, never as "no findings". |
| CS10 | **Superseded by LR3–LR6 (ADR-030): no hosted registry, no keyless signing.** *Push and sign, `main` only (D1, D2).* After CS1–CS9 pass on a push to `main`:<br>• push each tested image to **private** GHCR packages (D1), by digest;<br>• sign the digest **keylessly** with cosign, using the workflow's OIDC token (issuer `https://token.actions.githubusercontent.com`);<br>• attach the SBOM and provenance attestations.<br>Tags (`sha-<short>`) are for humans; the job summary records the digests. |
| CS11 | **Superseded by LR6 and LR9 (ADR-030): verification is pinned to the committed public key.** *Verification pinned to the exact signer (D2).* A follow-on step verifies each published digest with `cosign verify`, requiring all of:<br>• **certificate identity** exactly `https://github.com/w1t3ack3r/univarse/.github/workflows/ci.yml@refs/heads/main`;<br>• **OIDC issuer** exactly `https://token.actions.githubusercontent.com`.<br>Any other valid signature is **not** accepted. The **provenance and SBOM attestations** are verified too (`gh attestation verify`, pinned to this repository and signer workflow, checking each predicate type). |
| CS12 | **Re-scoped below (ADR-030).** *Least privilege, and untrusted PR code never runs with privileges.*<br>**Triggers:**<br>• **PR builds:** PR runs use only the `pull_request` trigger. `ci.yml` runs on `pull_request` and on `push` to `main`; `api-contract.yml` runs on `pull_request` (checked 2026-10-11).<br>• **Privileged triggers:** a `pull_request_target` or `workflow_run` job must **never** check out, build or execute PR code. GitHub's ordinary fork restrictions don't cover those triggers: they run with the base repository's token and secrets. This slice adds neither.<br>**Permissions:**<br>• the build, test and scan job has `contents: read` only;<br>• no job reachable from `pull_request` has `packages: write`, `id-token: write` or `attestations: write`;<br>• those permissions exist only on the publish job, which runs only on `push` to `refs/heads/main`.<br>**Evidence: policy verification; no live fork test.** A workflow-policy check runs as a **read-only** test (no permissions beyond `contents: read`) over the repository's real workflow files. It fails if:<br>• a job reachable from `pull_request` requests those permissions or references publish credentials;<br>• any workflow uses `pull_request_target` or `workflow_run` together with a checkout of the PR's head, or runs PR-supplied code.<br>Each PR run's summary also records that publishing and signing were not attempted. **A live fork PR test was not performed** (see Design notes). |
| CS13 | **Re-scoped below (ADR-030).** *Every gate fails for its intended reason* (throwaway PRs closed unmerged, as #35 and #43; run IDs recorded). Each mutation must fail at **its** gate, with the expected message, and publication must not run.<br>**Image content (CS1):**<br>• an image running as **root**: the user check fails;<br>• an image containing a **shell**: the shell check fails;<br>• **secret canaries**, each a harmless value built at run time and never committed, each expected to be found by the secret gate:<br>&nbsp;&nbsp;– in an app file under `/app`;<br>&nbsp;&nbsp;– inside a deployed workspace package under `node_modules/@univarse/…`, proving `node_modules` is covered;<br>&nbsp;&nbsp;– in an image **environment variable or label** (configuration);<br>&nbsp;&nbsp;– in a **build step** recorded in the image history.<br>&nbsp;&nbsp;Each must be reported at its location. A canary that isn't found fails the proof: the coverage claim isn't met.<br>**Vulnerabilities (CS7):**<br>• a known **fixable** HIGH/CRITICAL: the scan fails, naming it;<br>• a known **unfixed** HIGH/CRITICAL: the scan fails, naming it, which proves unfixed findings aren't ignored;<br>• an **expired** exception: the exception check fails;<br>• an exception **missing evidence or owner**: the exception check fails;<br>• `ignore-unfixed` added to the config: the policy check fails.<br>**Fail-closed and artifact consistency (CS9, CS6):**<br>• the **vulnerability DB unreachable**: the scan step errors, and the publish job doesn't run;<br>• the image **rebuilt** before publish (a substituted image): the CS6 consistency check fails.<br>**Signer identity (CS11), as negative steps expected to fail inside the verify job:**<br>• `cosign verify` with the **wrong identity** (another workflow or branch);<br>• an **unsigned** digest.<br>**Least privilege (CS12): fixtures, never executable workflows.** These are **workflow definitions stored as test fixture data** (for example under `tools/ci-policy/fixtures/`, outside `.github/workflows/`), so GitHub never runs them. The read-only policy test loads each fixture and must reject it with the expected message:<br>• a `pull_request` job requesting `id-token: write`, `packages: write` or `attestations: write`;<br>• a `pull_request_target` or `workflow_run` workflow that checks out the PR's head, or runs PR-supplied code;<br>• a PR-reachable job that references the publish credentials.<br>**Why fixtures:** a failing policy check doesn't stop another privileged job in the same PR from starting first, and GitHub warns against privileged workflows running untrusted PR code. So no proof PR adds a real job with signing permissions, or a real privileged trigger.<br>**Positive control:** the real workflow files must **pass** the same test. |
| CS14 | **Superseded by LR8 (ADR-030).** *Retention (D6).*<br>• **This slice deletes nothing:** there are no deployments yet, and Container Registry storage is free.<br>• **The policy is written down for when cleanup is built:** keep the newest **20 eligible, unused** versions per image. Never delete versions that are deployed or kept for rollback, or **their signatures and attestations**. "Untagged" alone doesn't make a version eligible, because cosign signatures and attestations are stored as separate artifacts that look untagged. |
| CS15 | **Superseded below (ADR-030).** *Required check.* Once CS1–CS13 are green, the PR-side job (e.g. `image-scan`) becomes a required status check in the `protect-main` ruleset, alongside `build-test`, `secrets-scan` and `api-breaking-changes`. |
| CS16 | *Evidence.* The completion record holds:<br>• latest-commit run IDs for the PR build/test/scan, the `main` publish, and verify;<br>• each CS13 proof with the gate and message it failed on;<br>• the tested image IDs and published manifest digests (showing CS6 held);<br>• image sizes;<br>• Trivy counts by severity, fixed and unfixed;<br>• any active exceptions;<br>• SBOM component counts.<br>The record states **explicitly** whether the roadmap's zero-findings exit is met. |

## Local release (ADR-030): accepted 2026-10-12

Accepted by the owner after review of #54 at `f116c9d`, with four tightenings now written into LR2, LR5, LR7–LR10 and CS12:
- strictly local signing, tested offline;
- the deploy verifies for itself and doesn't trust the record;
- a full proof on Windows, with explicit host networking and cleanup that stops only what the release started;
- superseded wording marked.

ADR-030 replaces CS10 and CS11's hosted publication with a **local** one. CS1–CS9 stay as built, and CI keeps running them on every PR as independent evidence, publishing nothing. The criteria below **replace CS10, CS11, CS14 and CS15**. CS12 and CS13 are re-scoped as noted, and CS16 stays.

**The local release:** one command (`pnpm images:release`) runs the whole pipeline on the developer machine, to produce a **verified local deployment**. It's **not** part of the everyday development loop: ordinary edits keep using `pnpm dev`, the tests and PR CI. It builds **once**, gates that build, then publishes, signs and verifies that same image. A failure at any stage stops it; nothing is published or signed after a failed or skipped gate.

| ID | Criterion |
|---|---|
| LR1 | *Build once, locally.* The API and web images are built from the current clean commit with the same Dockerfiles as CI. Their image IDs are recorded, and **every** later stage re-checks them (CS6). The release refuses to run if the working tree has uncommitted changes, or if the commit isn't on `main`. |
| LR2 | *The same gates as CI, on that build.* Trivy reads each image from a `docker save` tarball. **The Docker socket is never mounted into a tool container** (docs/09 §4.2). In order, on the recorded image IDs:<br>• inspection (CS1/CS2);<br>• the exception and policy check;<br>• the vulnerability gate (zero HIGH/CRITICAL, fixed or not);<br>• the secret gate (including `node_modules`, image config and history);<br>• the misconfiguration gate;<br>• the SBOM;<br>• the hardened smoke run (CS4);<br>• the **browser journeys** against the containerised API, worker and web (CS5).<br>ClamAV and the other services start only for the run and stop afterwards (memory). |
| LR3 | *A local registry.* A `registry` service in compose (profile `release`), pinned by digest, listening only on `127.0.0.1:5000`, with its own volume. It has no authentication, because it accepts loopback connections only. |
| LR4 | *Publish by digest, without rebuilding.* The gated images are pushed to the local registry. The pushed manifest's config digest must equal the recorded image ID, or the release fails (CS6). The manifest digests are recorded. |
| LR5 | *Sign with the owner's local key (ADR-030): **strictly local, with no public Sigstore upload or lookup**.*<br>• **No public services, by configuration:** cosign 3's defaults upload to the public transparency log and fetch a trusted root and signing config from public infrastructure. Signing, attesting and verifying are configured explicitly so they do neither: no transparency-log upload, no signing-config or trusted-root fetch, and verification against the key alone, with no log or certificate-timestamp requirement. The exact flags are recorded in the release tooling and in docs/09.<br>• **No public services, by test:** the sign, attest and verify stages run in tool containers attached **only** to an internal Docker network (`internal: true`) shared with the local registry. That network has no route to the internet, so any attempt to reach public Sigstore fails the release.<br>• **The signature:** `cosign sign --key` over each manifest digest.<br>• **The key:** the private key is encrypted and lives **outside the repository** (L3). Its password is entered by the owner at signing time and never stored by the tooling.<br>• **Attestations, signed with the same key:** the SPDX SBOM (`cosign attest --type spdxjson`) and a locally generated provenance statement (`--type slsaprovenance1`). The statement records the commit, the base-image digests, the Dockerfile, the build arguments, the tool versions, and that the build ran locally. |
| LR6 | *Verify against the committed public key.*<br>• `cosign verify` and `cosign verify-attestation` (both types) run with `--key infra/signing/cosign.pub` for each digest.<br>• **Negative checks:** verification with a different key must fail, and so must an unsigned digest pushed to the local registry for the check.<br>• The release prints the verified digests. |
| LR7 | *Record (an index, not proof).* The release writes a local record, `releases/<date>-<short-sha>.json` (git-ignored). It holds the commit, the image IDs, the digests, the Trivy counts by severity (fixed/unfixed), any active exceptions, the SBOM package counts, and the verification results. The record is **editable JSON**: it's an index for humans and tooling, and **never proof of verification** (LR9). |
| LR8 | *Retention (replaces CS14).* Nothing is deleted automatically. A manual `pnpm images:prune` keeps:<br>• the newest 20 verified releases;<br>• every digest the local deploy currently runs;<br>• every **rollback** digest named by the deploy;<br>• and, for all of these, their **signatures and attestations**.<br>Being untagged never makes an artifact eligible. |
| LR9 | *The deploy verifies for itself; the record isn't trusted.* Before running anything, the local deploy (ADR-030):<br>• runs `cosign verify` and `cosign verify-attestation` (SBOM and provenance) itself, against `infra/signing/cosign.pub`, on the **exact digests** it's about to run;<br>• confirms the provenance names the expected commit and Dockerfile.<br>**Tested:** a release record **edited to point at an unsigned digest**, or at one signed by another key, must be **rejected**, and nothing from it runs. |
| LR10 | *Proved on the owner's Windows machine, end to end.* One complete `pnpm images:release` run on Docker Desktop for Windows, with its record kept, shows:<br>• the base image's upstream signature verified (a **read-only** check of public data; our signing never contacts Sigstore);<br>• a **fresh** vulnerability database;<br>• all gates passing, including the browser journeys against the containerised API, worker and web;<br>• the tool containers reaching the local registry over the internal network, and failing to reach the internet;<br>• signing and verification succeeding offline.<br>**Prerequisite:** the containers use `--network host`, which Docker Desktop must have **enabled explicitly** (*Settings → Resources → Network → Enable host networking*). That's the owner's setting to change; the release checks for it and stops with that instruction if it's off.<br>**Cleanup:** stops **only** the containers and services the release itself started, never ones that were already running. |
| CS12 (re-scoped) | *Least privilege.* With no CI publish job, CI stays **read-only** (`contents: read`) on both of its triggers: `pull_request` for PRs and `push` to `main`. Neither requests `packages`, `id-token` or `attestations` write. No workflow uses `pull_request_target` or `workflow_run`. The fixture-based workflow-policy check still runs; it now also fails on any job that requests `packages`, `id-token` or `attestations` write. **Policy verification; no live fork test.** |
| CS13 (re-scoped) | *Every gate fails for its intended reason.* Proved locally (and in CI where the gate also runs), with run IDs or local release records kept:<br>• the inspection, vulnerability, exception, secret-canary, misconfiguration and `ignore-unfixed` mutations, as specified;<br>• a substituted image between gating and push;<br>• a wrong key, and an unsigned digest, at verification;<br>• the policy fixtures. |
| CS15 (replaces) | *Required check.* The CI job that builds and gates the images stays part of the required `build-test` check. There's no separate publish check. |

### Decisions (owner, 2026-10-12): L1–L5 accepted as recommended

- **Pinned tool images:** pulled with the owner's approval.
  - Trivy `aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`;
  - cosign `ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8`;
  - registry `registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8`.
- **The signing key:** the owner generates it and protects it and its password.

| # | Question | Options | Recommendation |
|---|---|---|---|
| L1 | Where does the signed image come from? | **a.** Built locally by the release, then gated locally (LR1–LR2). **b.** The image CI tested, downloaded and imported by its recorded ID. | **a.** It's fully local and needs no artifact download. CI's run stays independent evidence for the same commit. Base images pull fine now (the distroless runtime took 14 s on 2026-10-12). |
| L2 | How are Trivy and cosign run locally? | **a.** As their official container images, pinned by digest (nothing installed on Windows). **b.** As host binaries, checksum-verified. | **a.** Nothing to install, and the same versions as CI (Trivy 0.75.0, cosign 3.1.3). Both are downloads from their projects' official registries. I'll pull them only with your OK. |
| L3 | The signing key. | You run `cosign generate-key-pair` yourself (through the pinned cosign image) and choose the password. **I never see or handle it.** The private key goes in `%USERPROFILE%\.univarse\signing\` (outside the repo); `cosign.pub` is committed. Backup is yours. If the key is lost or leaked, re-key and commit the new public key in a PR that says why. | As described. The password is typed at each release (or set by you in your own shell); the tooling never writes it anywhere. |
| L4 | The local registry image. | `registry:3` (CNCF Distribution), pinned by digest, `127.0.0.1:5000` only. | As described. |
| L5 | Journeys in every local release (LR2), given the 8 GB machine? | **a.** Always. **b.** Smoke always; journeys only with `--full`. | **a.** That's what CS5 requires of the signed image. The release starts ClamAV only for the journeys and stops it afterwards. |

## Implementation evidence: the local release (2026-10-12)

**Built (`feat/images-local-release`):**
- **Commands:** `pnpm images:release` (`tools/images/release.mjs`) and `pnpm images:verify` (`verify-release.mjs`, what the deploy runs).
- **Stages and helpers:** the canary stage (`canary.mjs`), a shared tar reader (`tar.mjs`), the `registry` service, and the internal-only `release` network in compose.
- **`infra/signing/README.md`:** the owner's offline key-generation command.
- **Offline flags:**
  - **Signing and attesting:** `--tlog-upload=false --use-signing-config=false --allow-http-registry`.
  - **Verifying:** `--insecure-ignore-tlog=true` against the key alone.

**Findings that shaped the tool:**
- **Digests:** Docker Desktop's containerd image store pushes a different manifest digest from the one `docker image inspect` reports. Digests are therefore taken **from the registry**.
- **Same-image check:** it compares **config digests**, read from the `docker save` export, so it works with both Docker image stores.
- **The Dockerfile frontend** (`# syntax=docker/dockerfile:1.10`) was the one unpinned image found in the tally of pulled versus pinned images. It's now pinned: `docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5`.

**Rehearsal of commit `2fb3a158443f146f5c30f4b86c9941db587296c8`**, run with `--rehearsal` and a **throwaway test key** (not the owner's), on Docker Desktop for Windows. It ran 13:12–13:52 UTC, and its record is `releases/2026-10-12-2fb3a15-rehearsal.json`, kept locally.

| Stage | Result |
|---|---|
| Base image upstream signature | verified, `gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e` |
| Vulnerability database | fresh: downloaded 13:29:42Z; DB updated 09:47:21Z; Trivy 0.75.0 |
| Inspection; exceptions | pass; none active |
| Vulnerability gate | **0 HIGH/CRITICAL** in both images (23 MEDIUM and 8 LOW each, all unfixed) |
| Secret and misconfiguration gates; SBOM | pass; SBOM packages: API 329, web 36 |
| Hardened smoke | pass |
| Browser journeys (containerised) | **31 passed, 1 flaky**, passed on Playwright's automatic retry. The flaky test was desktop `auth.e2e.ts:143` [W9]: `toHaveURL /login/verify` timed out after 5 s. **Suspected cause: memory pressure** on the 8 GB machine, as measured on 2026-10-07 (spec 0012). **Not measured in this run.** |
| Published, API | manifest `sha256:b4427c22e14183fa9351a8c5411072126bfbcc6ba6414f599712a6de378ab7cb`, config `sha256:1c9e98b9032adf146ea48badcc42a69022cef315ed04946d329074e9d2e8ca39` |
| Published, web | manifest `sha256:08c351e823f114168ecf015d91039c7cce89af374b7bf1cf8f08f958efeeb27f`, config `sha256:551f03c572eee091ddb9f492d4fded13f9d30c4df5af600670e043f4b9829be3` |
| Same-image check | pushed config digests equal the gated ones |
| Signing and attestation | offline: the tool containers were attached only to the internal network, and the release confirmed they had no route to `rekor.sigstore.dev` |
| Verification against the public key | signature, SBOM and provenance verified offline (test public key sha256 `083769bb…`) |
| Negatives | **different key**: rejected ("accepted signatures do not match threshold, Found: 0"); **edited record pointing at an unsigned digest**: rejected ("no signatures found") |
| Cleanup | stopped ClamAV and the registry, which the release had started; Valkey, Vault, Mailpit and SeaweedFS, already running, were left alone |

Image sizes from Docker Desktop's containerd store (API 809 MB, web 273 MB) aren't comparable with CI's classic-store sizes (API 549 MB).

**Secret-gate coverage canaries (CS13).** These were run against the gated API image after that rehearsal. The canary stage is now part of every release.
- **What it does:** harmless, secret-shaped values are generated at run time and never committed. They're planted in a throwaway image built `FROM` the gated image. Each location gets a different rule:
  1. an app file, `/app/canary-app.js` (GitHub token);
  2. a file in the **real directory of the deployed `@univarse/db` package**, `/app/node_modules/.pnpm/@univarse+db@…/node_modules/@univarse/db/dist/` (GitHub token; the shorter `node_modules/@univarse/db` paths are symlinks to it);
  3. an environment variable (AWS key ID);
  4. a label (Stripe key);
  5. a `RUN` step, which exists only in the history (GitHub token).
- **Result:** the gate **failed** on the canary image, and **all five were reported at their locations**. The env and label canaries appear twice, because `ENV`/`LABEL` are also recorded in the history.
- **Mutation:** with `skip-patterns: ["**/node_modules/**"]` (Trivy's default restored), **only the `@univarse` package canary was MISSED** and the proof failed. The configuration was restored afterwards.

**Final rehearsal of commit `12524dd0d1f22905154e8806d3cdcce9c5191361`**, the tooling PR's last code commit. It includes the canary stage and the pinned Dockerfile frontend. It ran with `--rehearsal` and the throwaway test key, on Docker Desktop for Windows. It took 14:34:05–20:21:47 UTC (5 h 48 min); the build stage was slowed by npm requests that took over 80 s each. Its record is `releases/2026-10-12-12524dd-rehearsal.json`, kept locally.

| Stage | Result |
|---|---|
| Base image upstream signature | verified (`…nodejs24-debian13:nonroot@sha256:9eeb7f58…`) |
| Vulnerability database | fresh: downloaded 14:54:51Z; DB updated 13:18:23Z; Trivy 0.75.0 |
| Inspection; exceptions | pass; none active |
| Vulnerability gate | **0 HIGH/CRITICAL** in both images (23 MEDIUM and 8 LOW each, all unfixed) |
| Secret and misconfiguration gates; SBOM | pass; API 329 packages, web 36 |
| **Secret-coverage canaries** | the gate **failed** on the canary image, and **all five were found**: app file; `/app/node_modules/.pnpm/@univarse+db@…/node_modules/@univarse/db/dist/canary-pkg.js`; config env; config label; history-only RUN step |
| Hardened smoke | pass |
| Browser journeys (containerised) | **32 passed** (5.3 min), no flakes |
| Published, API | manifest `sha256:2ad00bcee54e669481fa965934bf649ef45e27f672c6cc7cc2148ccec95b171c`, config `sha256:43f4744d18d954cc1b3034d3f3809c71bcd5df051bf09a1d39036be46766a918` |
| Published, web | manifest `sha256:d233d3b0c1d1fa6013288359ea3a49b7530c738be28abc0d44695133be599486`, config `sha256:249a8ef781ffc949bebf4a6e0a85d25f5cecfbbd7b18430f58bb6563e4338a82` |
| Same-image check | pushed config digests equal the gated ones |
| Offline signing, attestation, verification | signed and attested on the internal network only, with no route to public Sigstore; signature, SBOM and provenance verified against the test public key (sha256 `083769bb…`) |
| Negatives | different key **rejected**; edited record pointing at an unsigned digest **rejected** ("no signatures found") |
| Cleanup | ClamAV and the registry, which the release started, were stopped; the four services already running were left alone |

**This is a rehearsal with a test key. It doesn't meet LR10.**

**Review fixes, 2026-10-13** (owner's review of `e43e32f`/`cb074ea`, confirmed with mocked process calls). The fixes are in a follow-up PR, because #55 had already merged.
1. **Rehearsal status is signed.**
   - **The release** writes `role` and `rehearsal` into the provenance it signs.
   - **`verifyRelease`** (the deploy's check) accepts only signed provenance with `rehearsal: false`; a missing flag is rejected. Only the release verifying its own rehearsal passes `allowRehearsal`. Editing the record's JSON flag changes nothing.
2. **Image roles are pinned in trusted code (`ROLES` in `release-lib.mjs`).**
   - **The record** must name exactly `api` and `web`, each with its trusted repository.
   - **The signed provenance** must name that role and the trusted Dockerfile, never the record's own value.
   - **Rejected:** a web image in the api slot, a web-only record, and an unknown extra role.
3. **Cleanup is ownership-scoped (`release-cleanup.mjs`).**
   - **Containers:** each run has a unique ID. Its containers carry it as a label and a name suffix, and cleanup removes only containers with that label; nothing is removed by name. A dirty-tree failure removes nothing.
   - **Services:** a service is recorded as started by the run **before** `up --wait`, so a failed startup is still stopped. Services that were already running are never touched.

**Regression tests** (CI): `verify-release.test.mjs` (8) and `release-cleanup.test.mjs` (5).
- **Mutations:** each original bug put back makes its tests fail:
  - no rehearsal check: 2 tests fail;
  - no exact-role check: 1;
  - provenance checked against the record: 1;
  - service recorded after `up`: 1;
  - removal by fixed names: 2.
- **New live negatives in every release:**
  - **A fully signed web image in the api slot.** Signatures live per repository; cosign 3 stores them as referrers, and `cosign copy`/`cosign load` can't move them into this plain-HTTP registry (both tried on 2026-10-13). So the release pushes the web image into the trusted `univarse-api` repository and signs it there with the same key, with its own SBOM and its **genuine** provenance (role `web`, the web Dockerfile).
    - **Disclosure:** this is **the only extra signing a release does**. Every statement it signs is true, and its tag (`role-swap-check-…`) says what it is.
    - **What it proves:** only the role binding can reject it.
  - **For a rehearsal:** verification in deploy mode.
  - **The unsigned-digest negative** pushes into the trusted `univarse-api` repository, so the only fault is the missing signature.
- **Rehearsal of commit `c8ab9bcae4bed63760ee2c30fe708af220f48bbf`** (the fix PR's last code commit), run with the throwaway test key on Docker Desktop for Windows. It took 21:53:14–22:32:48 UTC, and its record is `releases/2026-10-12-c8ab9bc-rehearsal.json`.
  - **The vulnerability DB:** the first download attempt failed. The **retry fetched it fresh** (downloaded 22:09:32Z; DB updated 19:08:28Z).
  - **Gates:** 0 HIGH/CRITICAL (23 MEDIUM and 8 LOW each, all unfixed), and all five canaries found.
  - **Smoke:** pass.
  - **Journeys:** **31 passed, 1 flaky**, which passed on retry. It was desktop `documents.e2e.ts:28` [FU9], upload → scan → download. Suspected cause: ClamAV had just been started by the release, plus machine load. Not measured.
  - **Published:**
    - **API:** manifest `sha256:ec77ee0d86e3673f56ee58dd7bad76c5918f8f38db4236a64d1014af9d228064`, config `sha256:bb30cf2f573693344a01f5677973f5409f9cb5066ca15e3bb619885968a79e2c`;
    - **web:** manifest `sha256:0328d78f9f9f9d5ed7e20d5588bc8a46701915df0b92902168c4dd7a6b0a6399`, config `sha256:295f0bc1878616127d01b2d55ad4e5de6a3ae0d9e4fbe08b3c7edd18b14767e7`.
  - **Signing:** both signed, attested and verified offline.
  - **All four negatives rejected for their intended reason:**
    - different key: "accepted signatures do not match threshold, Found: 0";
    - unsigned digest in the api repository: "no signatures found";
    - **fully signed web image in the api slot: "signed provenance does not name role api … it names: role web, infra/docker/web.Dockerfile"**;
    - rehearsal in deploy mode: "a rehearsal is never deployable".
  - **Cleanup:** no containers labelled with the run were left; the four services already running were untouched.
- **Every negative must fail for its intended reason** (`expectRejected`): a different key → signature mismatch; unsigned → "no signatures found"; role swap → "does not name role api"; rehearsal → "rehearsal is never deployable".
- **Why the reasons are checked:** the first rehearsal of `42503bd` (2026-10-12, otherwise green: 32/32 journeys, canaries found, offline signing) showed the role-swap negative rejected for the **wrong** reason ("no signatures found", because the web digest had no signatures under the api repository). That led to the change above. A pre-check against that rehearsal's images confirmed that a signed web image in the api slot is now rejected by the role check ("it names: role web, infra/docker/web.Dockerfile").


**LR10 met: the real-key release on `main` (2026-10-12/13).**
- **The release:** run by the owner in their own terminal, with their own key and password, on `main` at **`12083b8ebe7362db3123a8d67a1b4c3b2a09907f`**. That commit is #57, the merge that added `infra/signing/cosign.pub` (sha256 `386c0f55f82e60005a03526454cd287d10eb87534d4e829c1dd7e774900de194`).
- **The run:** 23:05:52–23:33:28 UTC (27.6 min), on Docker Desktop for Windows, with host networking enabled. Its record is `releases/2026-10-12-12083b8.json`, kept locally; `rehearsal: false`.

| Stage | Result |
|---|---|
| Base image upstream signature | verified (`gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e`) |
| Vulnerability database | fresh: downloaded 23:16:21Z; DB updated 19:08:28Z; Trivy 0.75.0 |
| Inspection; exceptions | pass; **none active** |
| Vulnerability gate | **0 HIGH/CRITICAL** in both images (23 MEDIUM and 8 LOW each, all unfixed) |
| Secret and misconfiguration gates; SBOM | pass; API 329 packages, web 36 |
| Secret-coverage canaries | gate failed on the canary image, and all five found, including `/app/node_modules/.pnpm/@univarse+db@…/dist/canary-pkg.js` |
| Hardened smoke; browser journeys (containerised) | pass; pass. The record notes pass only; the per-test counts are in the owner's terminal output |
| Published, API | `univarse-api:sha-12083b8`, manifest `sha256:8af794d21a95444fda06a876edfed514c1419e4a3ab146c02a8488fbbf5ed0db`, config `sha256:3258546e978949754caec5afab3168bc497793c81f36c64e8c93d328e2fc9199` |
| Published, web | `univarse-web:sha-12083b8`, manifest `sha256:1d0c627d2b838d4f08538b272cea0aec918baca2b3e2b146327ef22d8667553f`, config `sha256:62ff531d84a840e1919a1916d7f25e3888d57de323606708f5e09a3346c4cfd0` |
| Signing and attestation | offline: tool containers on the internal network only, with no route to public Sigstore |
| Negatives (a real release has no rehearsal check) | different key: rejected (signature mismatch); unsigned digest in the api repository: rejected ("no signatures found"); fully signed web image in the api slot: rejected, "signed provenance does not name role api … it names: role web" |

**Independent check after the release: the deploy's own verification.**
- **The release:** `pnpm images:verify releases/2026-10-12-12083b8.json`, with the committed key and `HEAD` = `12083b8`. **Both images' signature, SBOM and provenance verified offline.**
- **Counter-check:** the same check on the test-key rehearsal of `c8ab9bc`, verified against **that rehearsal's own test public key** (so its signatures and attestations verify), rejected both images **at the signed rehearsal check**: "signed provenance marks this a rehearsal …; a rehearsal is never deployable".
- **Not a key-separation proof:** this run didn't verify the rehearsal against the owner's real key. That separation is shown by the different-key negative in every release, and by #56's tests.

**Images-signed exit:** met. Both images are signed with the owner's key, with 0 HIGH/CRITICAL findings and no active exceptions.

**Key rotation (2026-10-19, after closure).** The password of the key that signed `12083b8` was lost, so the owner replaced the key offline; `infra/signing/cosign.pub` became sha256 `555c9408cac366559691946ae7531bf2f8d738e00dd80313a042b42739c79b73`, and then sha256 `48815009fd3ce65dd495bce41eea2312895960af2a2de8668e6559b5344a4e31` before that one signed anything: its password had been displayed in clear on entry (Windows PowerShell 5.1 echoes `Read-Host -MaskInput`), so it was treated as exposed (it was `386c0f55f82e60005a03526454cd287d10eb87534d4e829c1dd7e774900de194`). `12083b8`'s signatures no longer verify against the trusted key, so the evidence above stands as history, not as a current verification. The release now proves the password opens the key, and that the key is `cosign.pub`'s, before it builds anything (#78). See [the key history](../../infra/signing/README.md#key-history).

**Spec 0013 is closed (2026-10-13)** for its implemented scope. LR9's deploy integration ("nothing from a rejected record runs") is **transferred** to the local-deploy work as a blocking acceptance criterion: the deploy holds the registry lock throughout verification and startup, and verifies before starting any container.

The owner removed 14 accumulated rehearsal tags and trimmed the build cache (16.8 GB → 4.2 GB) on 2026-10-13. The `registry-data` volume must not be pruned: it holds the signed release.

### CS12 (re-scoped): the workflow-policy check

**Policy verification; no live fork test.** `tools/ci-policy/workflow-policy.mjs` (`pnpm ci:policy`) parses each workflow and runs nothing. CI runs it in the read-only `build-test` job (`contents: read`), straight after install. It fails closed: anything it doesn't recognise is refused.

| Rule | Rejected |
|---|---|
| Triggers | anything off the allowlist (`pull_request`, `push`, `workflow_dispatch`, `schedule`). The privileged triggers `pull_request_target`, `workflow_run`, `issue_comment` and `pull_request_review_comment` are named as such. Under one of them, checking out the PR's head, running PR-supplied code, or downloading another run's artifacts is reported separately. |
| Permissions | no workflow-level `permissions` (the token default may be write); `read-all`/`write-all`; **any** `write`, with `packages`, `id-token` and `attestations` named as publish/sign/attest; unknown levels |
| Credentials | in a PR-reachable workflow: any `secrets.*` other than `GITHUB_TOKEN`; `secrets: inherit`; calls to reusable workflows (whose permissions can't be checked here) |
| Publishing | in a PR-reachable workflow: `docker login`/`push`, `buildx build --push`, `cosign sign`/`attest`/`copy`, `crane`/`oras`/`skopeo` push or copy |
| Shell (owner review of #62) | every `run` step's effective shell (step, else job, else workflow `defaults.run.shell`) must be exactly `bash`. Without it GitHub runs `bash -e {0}` on Linux, with no `pipefail`, so `failing-command \| tee …` would pass. `sh` and the default are both rejected. |
| Supply chain (beyond the spec) | an action not pinned to a full commit SHA (or an image digest); `actions/checkout` without `persist-credentials: false` |

**Proof (`tools/ci-policy/workflow-policy.test.mjs`, 7 tests):**
- **Fixtures:** ten fixture workflows in `tools/ci-policy/fixtures/`. They are test data outside `.github/workflows/`, so GitHub never runs them. Each is rejected with exactly its intended messages: every problem matches an expected pattern, and every pattern is matched.
- **What the fixtures cover:** `pull_request` with `id-token`, `packages` or `attestations` write; `pull_request_target` with and without a head checkout; `workflow_run` running PR code; a PR job holding publish credentials and pushing/signing; no permissions; `write-all`; an unpinned checkout.
- **Positive control:** the real `.github/workflows` pass.
- **Mutation checks, local:** each of eight rules was disabled in turn: write scopes, privileged triggers, PR-head detection, credential secrets, publish commands, missing permissions, SHA pinning and persisted credentials. Each mutation failed its intended test, and the source was restored.
- **CI:** run `38339539471` on `e4cec32` (#59): 7/7, and the real workflows comply.
- **The new direct dependency:** `js-yaml@4.3.2`. It was already in the lockfile, so no new package was introduced. That doesn't mean no supply-chain risk: the check now depends on it directly. It is pinned exactly, installed from the lockfile with integrity hashes, and covered by `pnpm audit`.


### LR8: `pnpm images:prune` — met (first `--apply` 2026-10-13)

**Manual only, a dry run by default.** LR8 was held **pending** until two things had happened: the tool was reviewed and merged, and its first `--apply` completed with every kept release verifying afterwards. Both have now happened (evidence at the end of this section). A dry run is evidence about the plan, **not** proof that deleting is safe.

**Trust model: records nominate, never authorise.** Release records are editable indexes. What the prune keeps, and what it may delete, is decided from two sources only: what the registry holds, and **signed provenance that verifies against the committed key**. Role, commit, rehearsal flag and start time are all inside that signature.
- **Retention:** a *release* is a commit whose images carry verified provenance with `rehearsal: false`. The newest 20 by **signed** start time are kept, whatever any record says.
- **Nominations:** a record nominates only the exact tags `release.mjs` generates from its own commit and rehearsal flag. The tag must exist and point at the digest the record names. The record's `refs` are informational and never used.
- **Contradictions:** a nomination the registry contradicts protects that tag instead, and is reported.
- **Eligibility:** a nominated image is deleted only when it is **positively** classified:
  - signed by the trusted key as a rehearsal of the record's own commit;
  - signed as a release of the record's own commit, outside the 20;
  - or definitively *not* signed by the trusted key, by cosign's own verdict ("no signatures found", "no matching attestations", "accepted signatures do not match threshold").
- **Anything else protects the image:** an unreachable registry, a cosign crash, or provenance that is inconsistent or malformed.
- **"Not signed by the key" never authorises a deletion on its own.** A verdict is consulted only for a validly nominated tag: the exact generated tag, with the registry pointing at the record's digest, on a digest that no unknown tag, pin, shared artifact or kept release protects. An image that isn't nominated is never classified for deletion at all.
- **Never eligible, all with every signature and attestation of each, recursively:**
  - the kept releases, even with their records and tags gone;
  - every digest the local deploy runs or names for rollback (`releases/deploy-state.json`), and every `--keep repo@sha256:…`;
  - anything a tag without a valid nomination points at (e.g. `latest`);
  - orphaned signature indexes.
- **Shared digests:** a digest shared with a kept release, such as the unsigned-check image, is only untagged.
- **Remove-only tags:** negative-check tags are untagged; their digest is never deleted.
- **Indexes are traversed completely:** a kept digest keeps everything it references, recursively. That covers its own children when it is an index (e.g. a multi-platform image) and its signature index with every listed signature and attestation. A deleted index takes only those children that nothing kept references. The planner also refuses any plan whose kept set isn't closed over every index's children (owner review of `1a4497a`).
- **Every surviving signature index is a root:** any signature index whose subject this plan does not delete is protected with all its descendants before deletions are calculated. That includes orphans (subject absent) and the indexes of untouched images. A candidate that such an index still lists is kept, and only its tags go. The planner also refuses any plan that deletes something a surviving signature index references (owner review of `f2bdc2b`).
- **Signature storage:** this registry has no OCI referrers API, so cosign 3 uses the **tag-schema fallback**. A digest's signature, SBOM attestation and provenance attestation are manifests listed in an index tagged `sha256-<hex>`, and they are protected together with their subject.

**Exclusion: the whole operation, not just collection.**
- **The registry lock:** `tools/images/registry-lock.mjs` creates a directory atomically. It is never taken over automatically, and a run only removes its own lock. Holders:
  - **every release**, from before its first step until the end of its cleanup;
  - **the prune**, in both modes, because even a dry run may start and stop the registry;
  - **the local deploy**, once it is built (a requirement on it).
- **The registry is offline for the whole `--apply`:** the public registry (`127.0.0.1:5000`, alias `registry:5000`) is stopped first. The prune works through a private instance on the same storage: the same pinned image and hardening, a random loopback port, and a private alias on the internal release network.
- **What that covers:** planning, verification, deletion, collection and the final verification all happen with no other path to the registry. A writer that ignores the lock, such as a manual `docker push` to `localhost:5000`, gets a refused connection instead of an interleaved write.
- **Afterwards:** the public registry is restored only if it was running before, and the lock is released last.
- **Documented operational limitation:** don't start the public registry (`docker compose … up registry`) during an apply. Doing so by hand bypasses the lock, and nothing in the tool can prevent it.

**What `--apply` does, in order:**
1. **Takes the lock** and takes the public registry offline.
2. **Plans**, classifying every tagged image in the release repositories with cosign, offline.
3. **Re-verifies every kept release** against the committed key, from **trusted data only**: every digest whose provenance verified as a release of a kept commit, in that role's repository, pairing so that every such digest is verified. Records aren't consulted, so a kept release with no record is verified too. If any kept release can't be fully verified (a role is missing), or one fails, it **stops before deleting anything** (owner review of `1a4497a`).
4. **Deletes:** removes nominated tags, then deletes eligible manifests leaf-first (referrers, then their index, then the image).
5. **Re-reads the registry** to prove every kept manifest survived.
6. **Collects:** runs blob garbage collection **without `--delete-untagged`**, on quiescent storage. It runs only after its dry run shows no kept blob is eligible; a dry-run output it doesn't fully parse also stops it.
7. **Re-verifies every kept release** from the same trusted targets.
8. **Restores** the public registry if it was running, and **unlocks**.

**Release-side changes:**
- Each release holds the lock for its whole run.
- It records the tags it pushed (`refs`, schema 2; informational only).
- It removes its host-side `localhost:5000/…` tag copies at cleanup.

**Proof, local (CI runs the same node tests):**
- **Plan tests:** `tools/images/prune.test.mjs`, 24 tests, on a synthetic registry laid out like cosign's. The edited-record regression covers five edits:
  - the real release relabelled a rehearsal;
  - its record deleted;
  - a rehearsal record claiming the real release's commit, tags and digests;
  - a rehearsal record naming the real digests;
  - `refs` claiming every tag, including signature indexes.
- **The kept release intact:** in each edited-record case, its images, signature indexes, signatures and attestations all survive.
- **Other attacks covered:**
  - twenty fabricated newer "releases" in records, against signature-based retention;
  - an off-scheme record, which nominates nothing;
  - inconclusive, other-commit and expired-other-commit verdicts, all protected;
  - a registry tag contradicting its record, which is neither deleted nor untagged;
  - a same-commit rehearsal with byte-identical images, where even with the release's own record and tags gone, only the rehearsal's tags go;
  - remove-only tags untagged but never deleted;
  - "not signed by the key" alone never authorises deletion. Untouched cases: a generated-looking tag with no record, an arbitrary tag, a repository no release uses, an image left only under its signature index, and a tag contradicting its record (not even untagged);
  - cosign verdict classification;
  - a protected multi-platform index sharing a child with a deletion candidate, where the shared child, its signature and the index are kept while the candidate and its unshared child go;
  - a candidate that is itself a child of a pinned index;
  - a kept release published as an index, its record gone, sharing a child with a rehearsal index;
  - verification targets built from signed provenance, covering a kept release with no record and a rebuilt one with two signed api digests, and never taking the role-swap copy as the api image;
  - a kept release missing a role, which stops `--apply` before verifying or deleting;
  - an orphan signature index sharing a child with a deletion candidate's signature index, where the orphan index and both its children are kept and still reported as an orphan, while the candidate's unshared artifacts go;
  - an orphan signature index listing a candidate itself, which keeps the candidate and removes only its tag;
  - the exclusion order, checked in the source.
- **Lock tests:** `registry-lock.test.mjs`, 3 tests: refusal naming the holder; no takeover of stale or half-written locks; a run removes only its own lock.
- **Mutation checks:** each rule disabled in turn was caught by its intended test (16 rules), with one exception. The newest mutation lets an unsigned verdict alone make any tagged image removable; it is caught by the unsigned-alone test and the off-scheme test. After the review of `1a4497a`, five more were added:
  - reintroducing the reported bug (traversing signature indexes only) is caught by the three index tests, even with the defence-in-depth check disabled;
  - not removing a dropped index's children is caught;
  - dropping the missing-role refusal, verifying only the first digest per role, and ignoring the role are each caught;
  - removing `--apply`'s refusal is caught.
  - **After the review of `f2bdc2b`:** removing the orphan/surviving-index roots is caught by both new tests, even with the new invariant also disabled. A redundant line, which dropped kept candidates already skipped by `remove()`, survived mutation and was deleted.
  - **A harness fault, found and fixed:** a mutant that doesn't parse makes the test file fail to load, with no per-test failures listed. Every mutant is now checked with `node --check` first. The two survivors reported above (the deliberately redundant signature layers) parse, so they are genuine. Two signature-based layers are **deliberately redundant**: the kept-release root, and eligibility's "not a kept release" condition. Each alone survives mutation; disabling both is caught, by the planner's final defence-in-depth check and, with that also disabled, by the same-commit rehearsal test.

**Dry run against the real local registry (2026-10-13, under the lock; repeated after the review fixes from a cold start).** The after-fix run lists `--apply`'s verification targets from signed provenance: `12083b8` api `sha256:8af794d21a95444fda06a876edfed514c1419e4a3ab146c02a8488fbbf5ed0db`, web `sha256:1d0c627d2b838d4f08538b272cea0aec918baca2b3e2b146327ef22d8667553f`. The plan is unchanged: 45 deletions and 4 untags. The cold start exposed a race (compose reports healthy before Docker Desktop forwards the port), so the tool now waits for `/v2/` to answer.
- **Kept by signature:** commit `12083b8ebe7362db3123a8d67a1b4c3b2a09907f`, with its images, unsigned-check and role-swap tags, and all signature artifacts.
- **Rehearsal images:** all nine were classified by cosign as *not signed by the committed key* (test key).
- **Untagged:** four tags: two on the shared unsigned-check digest, and two legacy `univarse-unsigned-check` tags.
- **Left alone:** `latest` and `role-swap-check-test`, which have no valid nomination.
- **Listed for deletion:** 45 manifests, all rehearsal images with their signature artifacts.

**Garbage-collection dry run:** `186 blobs marked, 0 blobs and 0 manifests eligible`, which confirms the parsed format.

**LR8 met: the first `--apply` (2026-10-13).**
- **The run:** the owner ran `pnpm images:prune --apply` on `main` at `af72e43` (#60, merged at the reviewed `c5b72c9`; CI run `38345093753`: prune 24/24, lock 3/3, all jobs green).
- **The plan:** exactly the dry run's. 4 untags: two rehearsal tags on the shared unsigned-check digest, and the two legacy `univarse-unsigned-check` tags. 45 manifest deletions: the four rehearsals' nine images, each with its signature index and three signatures/attestations. `univarse-api:latest` and `role-swap-check-test` were left alone as unowned.
- **Before deleting:** `12083b8` was verified from signed provenance: signature, SBOM and provenance, for api `sha256:8af794d21a95444fda06a876edfed514c1419e4a3ab146c02a8488fbbf5ed0db` and web `sha256:1d0c627d2b838d4f08538b272cea0aec918baca2b3e2b146327ef22d8667553f` (1 verification covering all 1 kept release).
- **Collection:** 72 unreferenced blobs were collected, none of them kept, without `--delete-untagged`.
- **After collection:** the same verification passed again.

**Independent check afterwards, outside the prune tool:**
- **Lock and containers:** no registry lock left behind, and no private registry container left running.
- **Registry contents:**
  - `univarse-api`: `sha-12083b8`, `unsigned-check-sha-12083b8`, `role-swap-check-sha-12083b8`, the signature indexes of `8af794d2…` and `1d0c627d…`, and the unowned `latest`/`role-swap-check-test` with their signature index;
  - `univarse-web`: `sha-12083b8` and its signature index;
  - `univarse-unsigned-check`: no tags.
- **Deploy check:** the exact command run was `pnpm -s images:verify releases/2026-10-12-12083b8.json --commit 12083b8ebe7362db3123a8d67a1b4c3b2a09907f`.
  - **Why `--commit`:** `images:verify` checks against `HEAD` unless told otherwise, and the checkout was then at `af72e43`, the #60 merge on which the apply ran. That commit is **not** the release's. The flag names the commit the release's provenance is signed for, so the signed `commit` must match it. The prune's own before/after verifications likewise use each kept release's signed commit.
  - **Verified against:** `infra/signing/cosign.pub` (sha256 `386c0f55f82e60005a03526454cd287d10eb87534d4e829c1dd7e774900de194`). **Both images' signature, SBOM and provenance verified offline.**
- **Blobs:** every blob of the 20 manifests reachable from tags is present: configs, layers and signature/attestation layers, **164 present, 0 missing**. (`cosign verify` doesn't fetch image layers, so this checks what collection could have removed.)


### CS13 (re-scoped): every gate fails for its intended reason — met (#62, 2026-10-13)

**One gate code path.** The gate commands now live in one module, `tools/images/gates.mjs`, used by the release (`release.mjs`), the secret-canary proof (`canary.mjs`) and the CS13 harness. A proof therefore exercises exactly what a release runs. A unit test fails if `release.mjs` or `canary.mjs` grows its own Trivy command again.

**The harness: `pnpm images:proofs` (`tools/images/gate-proofs.mjs`).**
- **Mutants:** each proof builds **one harmless mutant at run time**, on the same pinned runtime base. Nothing vulnerable-looking is committed: a committed `package.json` naming an old `lodash` would set off the repository's own dependency alerts.
- **Pass condition:** each proof runs the real gate and requires three things:
  - the gate **fails**;
  - **for its intended reason**: the expected message, and no other violation;
  - **a clean control**, identical but for the mutation, **passes** the same gate.
- **Isolation:** its own Trivy cache volume, a fresh DB first (it refuses to prove anything without one), a throwaway tmpfs registry on a random loopback port, and run-labelled images and containers, all removed at the end. It never touches the release registry or the release's Trivy cache.
- **The record:** `releases/proofs/<date>-<sha7>.json` (git-ignored). It holds each proof's gate, mutation, expected message, an excerpt of the actual failure, and the control result.

| Proof | Mutation (one change from the clean control) | Gate | Failed with |
|---|---|---|---|
| CS1-root-user | `USER 0:0` | inspection | `user is "0:0", expected "65532:65532"` (the only violation) |
| CS1-shell | dash copied to `/bin/sh` (the base links `/bin` → `/usr/bin`) | inspection | **both** detections: `shell present: /usr/bin/sh` (file listing) and `running "sh" succeeded` (execution); nothing else |
| CS7-fixable | `lodash` 4.17.4 (`package.json` only) | vulnerability | `CVE-2019-10744` CRITICAL, fixed in 4.17.12; every HIGH/CRITICAL finding is that package |
| CS7-unfixed | `ip` 2.0.1 (`package.json` only) | vulnerability | `CVE-2024-29415` HIGH, **no fixed version** (status `affected`): unfixed findings block |
| CS7-misconfiguration | a Dockerfile whose last `USER` is `root` | Dockerfile misconfiguration (`trivy config`) | `DS-0002 (HIGH): Last USER command in Dockerfile should not be 'root'` |
| CS7-exception-expired | an exception past its `expired_at` | exceptions | `expired on 2026-10-01` (the only failure) |
| CS7-exception-incomplete | an exception without `statement` and `owner` | exceptions | `missing statement`, `missing owner` (exactly those two) |
| CS7-ignore-unfixed | `--ignore-unfixed` in a workflow | exceptions and policy | `uses ignore-unfixed (ADR-029 …)` |
| CS9-db-unreachable | no network to any DB mirror | fresh vulnerability DB | Trivy `failed to download vulnerability DB` on every attempt; the release then stops before scanning |
| CS6-substituted-before-push | the gated tag re-pointed after gating | artifact consistency, re-checked before every later stage | `changed since it was gated: config …, not the gated …` |
| CS6-substituted-at-push | a different image pushed under the release tag (throwaway registry) | artifact consistency at push | `pushed … has config …, not the gated …` |

**Proved elsewhere, and cited by the record rather than re-run:**
- **Secret-gate canaries:** every release, through the same `gates.secret`. Five locations, including `node_modules/@univarse` and the image configuration and history (LR10 record).
- **At verification:** a different key, an unsigned digest and a role swap, in every release, each rejected for its intended reason (LR6, LR9; LR10 record).
- **Workflow policy:** the fixtures (CS12, in CI).

**Gate-flag tests:** `tools/images/gates.test.mjs`, 7 tests, which stop a later edit weakening a gate. They check:
- the vulnerability gate keeps `--severity HIGH,CRITICAL --exit-code 1`, with no `ignore-unfixed`;
- the secret gate keeps image-config scanning and its config, and its report scans exactly what it gates;
- the misconfiguration gates keep HIGH/CRITICAL;
- the fresh-DB step cleans first, bounds its retries and reports failure;
- the push check compares configs;
- the release and the canary proof use only `gates.mjs`.

**Mutation checks:**
- **Flags:** six gate weakenings, each caught by its intended test: no `--exit-code`, `--ignore-unfixed` added, no image-config secret scanning, no DB clean, a DB failure ignored, severity dropped from the misconfiguration gate.
- **End to end:** with the real vulnerability gate broken (no `--exit-code 1`), the harness itself reports the vulnerability proofs **NOT PROVED** and exits non-zero.

**Owner review of `e7a96e8`: two failure paths fixed.**
1. **The DB cleanup result was discarded.** `freshDb()` ignored a failed `trivy clean --vuln-db`, so a mocked failed cleanup followed by a successful download returned `ok: true`. It now stops with "could not remove the old vulnerability database": no download runs, and the release throws before any scan. A regression test pins this; the mutation that ignores the cleanup result again is caught.
2. **CI could hide a failed proof run.** Steps piping into `tee` ran under GitHub's default `bash -e`, without `pipefail`. That also masked **the exceptions-and-policy check** (`node tools/images/exceptions.mjs | tee …`); the workflow-policy CLI was partly covered by its own test running first.
   - **The fix:** both workflows now set `defaults.run.shell: bash` (`-eo pipefail`), and the CS12 policy rejects any `run` step whose effective shell isn't `bash`.
   - **The behavioural test:** it runs the real `ci.yml` lines for the gate proofs and the exceptions check, the way GitHub would, with the command made to fail. Configured as committed, both steps fail. Under `bash -e` they would pass, which shows the test can tell the difference.
   - **Mutations caught:** removing the workflow default; removing the policy rule; a `bash` template without `pipefail`.

**Harness faults found while building it:**
- **The shell proof's expected pattern** looked for `shell present: /bin/sh` and was satisfied by the execution check alone. The listing check had in fact caught the shell at `/usr/bin/sh`, because the base's `/bin` is a symlink. The proof now requires both detections. This was a proof fault, not a gate gap.
- **Unparseable mutants:** every mutant is parse-checked, so a mutant that doesn't parse is never mistaken for a surviving one.


### CS16: the completion record (2026-10-13)

**Status of every criterion:**
- **Met:**
  - CS1–CS9, in CI since #49–#51 and in every local release;
  - CS12, #59, with the shell rule added in #62;
  - CS13, #62;
  - LR1–LR8 and LR10.
- **LR9, the verifier: met.** `verifyRelease` (`pnpm images:verify`) verifies the exact digests itself, against `cosign.pub`.
  - **Where the expected values come from:** the **roles and Dockerfiles from trusted code** (`ROLES` in `release-lib.mjs`), never from the record; the **commit from the deployment target** (`HEAD`, or `--commit`).
  - **What must match:** the signed provenance must **match** those, and a rehearsal never verifies for deployment.
  - **Rejected:** an edited record, whether it names an unsigned digest, another key's signature, a swapped role or a rehearsal.
  - **Tested** in `verify-release.test.mjs`, and exercised in every release's negatives.
- **LR9, the deploy integration: not met. Transferred.** The deploy integration ("nothing from a rejected record runs") needs the local deploy, which isn't built. **LR9 as a whole is therefore not marked met.** It is carried forward as a **blocking acceptance criterion of the local-deploy work** (docs/18). The deploy must:
  1. **hold the registry lock** (LR8) for the whole of verification and startup;
  2. **verify before starting any container**: the exact digests it will run, with this verifier, against roles and Dockerfiles from trusted code and the commit it was asked to deploy;
  3. **start nothing** if any image is rejected, which must be shown by a test with an edited record;
  4. **run exactly the digests it verified**, never a tag.
- **Superseded:** CS10, CS11, CS14 and CS15 (ADR-030; replaced by LR1–LR10).

**Run IDs and records:**
- **CI on the latest commit of the CS13 PR:** run `38353636373` on `1951d52` (#62).
  - **Image and policy checks:** gate proofs **11/11**, gates 7/7, workflow policy 9/9, every image-tools suite green.
  - **Other suites:** integration 348 passed (1 skipped), journeys 32/32 twice, RLS passed.
  - **Other checks:** `api-breaking-changes` and `secrets-scan` passed.
- **CI on `main` after the merge:** run `38355008938` on `71d9d66`: all jobs green: gate proofs 11/11, every image-tools suite green (gates 7/7, prune 24/24), integration 348 passed (1 skipped), journeys 32/32 twice, RLS passed.
- **The local publish (LR10):** the owner's release on `main` at `12083b8ebe7362db3123a8d67a1b4c3b2a09907f`, record `releases/2026-10-12-12083b8.json`.
- **Verify:**
  - in the release;
  - independently, after it: `pnpm images:verify` (#58);
  - after the first prune: `pnpm -s images:verify releases/2026-10-12-12083b8.json --commit 12083b8ebe7362db3123a8d67a1b4c3b2a09907f`, with all 164 blobs present (#61).
- **CS13 proofs, local:** clean-tree record `releases/proofs/2026-10-13-05-41-21-e7a96e8.json`, 11/11. Each proof's gate and failure message is in the CS13 table above.

**The tested and published images (CS6 held: the pushed config equals the gated image's).**

| Image | Manifest digest | Config (image ID) | Size | SBOM packages |
|---|---|---|---|---|
| API/worker | `sha256:8af794d21a95444fda06a876edfed514c1419e4a3ab146c02a8488fbbf5ed0db` | `sha256:3258546e978949754caec5afab3168bc497793c81f36c64e8c93d328e2fc9199` | 808,506,101 bytes | 329 |
| Web | `sha256:1d0c627d2b838d4f08538b272cea0aec918baca2b3e2b146327ef22d8667553f` | `sha256:62ff531d84a840e1919a1916d7f25e3888d57de323606708f5e09a3346c4cfd0` | 273,245,723 bytes | 36 |

**Trivy:** 0.75.0, with the DB updated 2026-10-12T19:08:28Z and downloaded fresh 23:16:21Z.

| Image | CRITICAL | HIGH | MEDIUM | LOW |
|---|---|---|---|---|
| API/worker | 0 | 0 | 23 (fixed 0, unfixed 23) | 8 (fixed 0, unfixed 8) |
| Web | 0 | 0 | 23 (fixed 0, unfixed 23) | 8 (fixed 0, unfixed 8) |

**Active exceptions:** none (`.trivyignore.yaml` is empty).

**The roadmap's "Images signed, 0 high/critical findings" exit is met.** Both images are signed with the owner's key, have zero HIGH/CRITICAL findings (fixed or not), and run under no active exception.

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
- **(Superseded by ADR-030.)** **Private packages and verification:** verifying private GHCR images needs a registry login, with read permission, inside the verify job. The public Sigstore log still records the signing identity and digest (D2).
- **Fork PRs:** GitHub gives `pull_request` runs from forks a read-only token and no secrets. That protection covers `pull_request` only, which is why CS12 also bans privileged triggers (`pull_request_target`, `workflow_run`) from touching PR code.
  - **Label of the evidence:** CS12's evidence is **policy verification**. **A live fork test was not performed.**
  - **If one is wanted later:** a fork PR could come from an organization the owner controls; a second personal account isn't required. It's not planned for this slice.

## Decisions (owner, 2026-10-11)

| # | Decision |
|---|---|
| D1 | **Superseded by ADR-030 / L4: a local registry on `127.0.0.1`.** **Registry: GHCR, private packages initially.** Pushed only from `main` with the workflow's `GITHUB_TOKEN`; no new account or long-lived credential. GitHub currently lists Container Registry storage and bandwidth as free, which differs from its general Packages allowances. Changing visibility is the owner's action, not this slice's. |
| D2 | **Superseded by ADR-030 / L3: a local cosign key; nothing is uploaded to public Sigstore (LR5).** **Keyless cosign plus GitHub artifact attestations.** Verification requires the exact repository, workflow, `refs/heads/main` and the OIDC issuer `https://token.actions.githubusercontent.com`, never "any valid signature". The provenance and SBOM attestations are verified as well (CS11). |
| D3 | **`gcr.io/distroless/nodejs24-debian13:nonroot`, digest-pinned** (the maintained, supported listing; Debian 12 is superseded). Its upstream signature is verified (CS3), and its compatibility is proved by the real journeys (CS5). |
| D4 | **Block all HIGH/CRITICAL findings by default, fixed or unfixed.** `ignore-unfixed` is not the gate.<br>• **Exceptions** need the specific finding and package, evidence, an owner and an expiry.<br>• **Visibility:** an accepted unresolved risk stays visible, and while it exists the roadmap's zero-findings exit can't be claimed (CS7, CS16). |
| D5 | **Our two application images** (API/worker and web) for this slice. Scanning the **third-party images** stays **explicitly pending**, until the local production-like stack runs them by digest (ADR-030). |
| D6 | **Retention: the newest 20 eligible, unused versions per image.** Deployed and rollback versions, and their signatures and attestations, are protected. Being untagged doesn't make a version eligible. This slice records the policy and deletes nothing (CS14). |

## Docs to update in the same change

- **docs/09:**
  - **§2.1 rule 2 and §2.2:** the runtime base becomes `gcr.io/distroless/nodejs24-debian13:nonroot`, and the builder Debian 13. The real Dockerfiles replace the reference one. Done in this revision: docs/09 now names Debian 13 for both the builder and the runtime, and §1 no longer lists `argon2`.
  - **§3:** the pipeline as built: one artifact from test to signature, fail-closed gates, the exact verify identity, how to verify.
  - **§8:** the checklist items this slice closes, with zero-findings stated honestly.
- **docs/13 §3:** the image jobs, their permissions, the workflow-policy check, and the required check.
- **docs/19:** an ADR for registry, signing and the findings policy (D1, D2, D4).
- **docs/18 Phase 0:** whether "Images signed, 0 high/critical findings" is met by the local release, with the evidence. It isn't met while any exception is active. Staging's criteria stay deferred.
- **README:** a status row, and how to verify an image (`cosign verify …` with the exact identity, `gh attestation verify …`).

## Out of scope (tracked)

| Item | Where |
|---|---|
| **Third-party images:** scanning, digest pinning in the local stack | **Pending until the local production-like stack** (D5, ADR-030) |
| Registry cleanup automation | LR8: manual `pnpm images:prune` only |
| Re-scan of released digests on a schedule | docs/09 §3, as a local command; not in this slice |
| Admission control requiring signed images (Kyverno) | docs/09 §4.1, Phase 8 / production |
| Renovate for base digests and actions | docs/09 §1 |
| `osv-scanner`, license check and `pnpm audit signatures` in CI | docs/09 §1; a separate dependency-scanning slice |
| Clean local E2E run (spec 0012: cause measured) | Pending separately |
| Product cache across instances (spec 0003 P7), `GET /users` pagination, key-forget broadcast, shred ledger | Unchanged: still open |
