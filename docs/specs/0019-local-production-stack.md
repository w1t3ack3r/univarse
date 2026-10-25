# Spec 0019: The local production-like stack — verified digests, PgBouncer, HTTPS edge, Vault with TLS

**Status:** **Accepted (2026-10-18)** by the owner: revision 1, D1–D10 as written. **PR A merged** (#77, #82, #83). **Revision 2 (2026-10-21), for PR B:** the owner approved B1–B6 below, which change D5 (the edge CA) and extend LS1, LS5, LS7, LS9 and LS11 with the owner's safeguards. **PR B merged** (#84). **Revision 3 (2026-10-21), for PR C:** the owner chose C1 (no plaintext exception) and C4 (a throwaway Vault for the fail-closed check); PR C splits in two (C5). **PR C merged** (#85, #86). **The release `f6abefa` runs on the stack (2026-10-22): items 7.1–7.4 are met, and ADR-018 is closed.**
**Phase:** 0. Roadmap items **7.1–7.4** under [ADR-030](../19-decision-log.md): PgBouncer in the deployed path, a local HTTPS edge with a local certificate authority, Vault with TLS and its audit device, and a local deploy of verified digests (carrying spec 0013 LR9's deploy integration as a blocking criterion). Item 7.5 (backups with a rehearsed restore, and the shred ledger) is a separate spec.
**Builds on:**

- [ADR-030](../19-decision-log.md): everything local; the staging criteria become local criteria;
- [spec 0013](0013-container-images-scan-sign.md): the gated, signed images, `verifyRelease`, the registry lock, the local registry;
- [spec 0017](0017-pgbouncer-isolation.md): the source-built PgBouncer image, transaction pooling, per-role pools;
- [spec 0006](0006-envelope-encryption.md) and ADR-018/ADR-023: envelope encryption through Vault Transit;
- [09](../09-container-security.md) §4.2: the hardened compose; [10](../10-infrastructure-and-deployment.md): Caddy as the production edge, the memory budget;
- [spec 0016](0016-platform-invalidation-outbox.md): the worker's relay role.

## Why

Phase 0 can't close until the application runs the way it will in production, on this machine (ADR-030). Today it runs as development servers against the owner's native PostgreSQL, a dev-mode Vault without TLS, no PgBouncer outside the test runs, and an HTTP edge. Three exit criteria wait on one stack:

- **"Staging environment"** → a local production-like stack running the verified images by digest;
- **"CSP enforced"** → over local HTTPS, with `Secure`/`__Host-` cookies;
- **"Staging deploy"** → a local deploy of verified digests, with LR9's guarantees: the registry lock for the whole of verification and startup, verification before any container starts, and nothing from a rejected record runs.

And two closures ride on it: PgBouncer in the deployed path (ADR-015) and ADR-018's closure, by running the `vault` provider over TLS with an audit device.

## Decisions

| #   | Decision | Recommendation |
| --- | -------- | -------------- |
| D1  | **Scope and phasing.** This spec covers 7.1–7.4, in three PRs: **A**, the stack, its deploy and PgBouncer (7.1, 7.4); **B**, the HTTPS edge (7.2); **C**, Vault with TLS and audit (7.3). Backups (7.5) get their own spec. | **As written.** The deploy comes first because it's the only way the stack starts (LS3): a stack that can be started by hand from tags would be the thing LR9 forbids. |
| D2  | **The stack's own PostgreSQL.** A digest-pinned `postgres:18` container on an internal network, with its own volume and superuser, **not** the owner's native PostgreSQL. | **As written.** The stack must never touch development data or need the owner's superuser password, and production runs the database beside the app, not on a laptop's host. About 200 MB. |
| D3  | **Migrations and seed run as a job from a fourth signed image.** A `migrate` role (Prisma CLI, both schemas' migrations, the seed, `rls:check`), built, gated, signed and verified like `api` and `web`, runs once per deploy on the database network before anything else starts. | **(a) The `migrate` image.** It's how production runs migrations (docs/07 §1: the migrator role is "migration job only"), and it keeps "only verified digests run" true for the schema too. The alternative, running `pnpm db:migrate` from the checkout through a temporarily published port, breaks 09 §4.2's "never publish the database" and runs unverified code against the stack. |
| D4  | **PgBouncer becomes a release role.** The source-built image (spec 0017) is gated, signed and verified with the release, not rebuilt at deploy. | **As written.** Release roles become `api` (also the worker), `web`, `migrate`, `pgbouncer`. `verifyRelease`'s "exactly these roles" rule extends to four. |
| D5  | **The edge is Caddy**, the production edge (docs/10 §3), digest-pinned, with **its internal certificate authority** (`tls internal`). Listening on `127.0.0.1:443` (and `:80`, redirecting). The root certificate is exported to `~/.univarse/stack/`; **installing it in the OS and browser trust stores is the owner's step.** | **As written.** One edge implementation from local to production. Phones on the LAN are out of scope: they'd need a public wildcard DNS name (e.g. `sslip.io`), which ADR-030 would have to allow first. |
| D6  | **Stack hostnames: `*.stack.univarse.localhost`.** The seed takes its domain from the job's environment (default `univarse.localhost`, unchanged for development). | **As written.** The stack sends production's HSTS header, and HSTS binds a hostname **across ports**; on the development names it would force HTTPS onto the dev edge (`:4180`). A separate subdomain keeps the two apart, and `*.localhost` resolves on the machine with no hosts file. |
| D7  | **TLS inside the stack:** the database path (client → PgBouncer `require`, PgBouncer → PostgreSQL `verify-full`) and Vault, with certificates from **one stack CA** that `pnpm stack:init` generates. Valkey, SeaweedFS, ClamAV and Mailpit stay plaintext, **on internal networks only**, stated as a limit. | **As written.** TLS where the roadmap and ADR-015/ADR-018 ask for it, without turning every hop into a certificate. Each internal service is unreachable from the host and from the edge network. |
| D8  | **Third-party images** (PostgreSQL, Valkey, SeaweedFS, Vault, Caddy, Mailpit, ClamAV) are digest-pinned in the stack file; the deploy scans each with the pinned Trivy and **reports** HIGH/CRITICAL findings; it doesn't block on them. | **Report, don't block.** ADR-029 D4 (zero HIGH/CRITICAL) governs the images UniVarse builds; upstream images change on their maintainers' schedule. Blocking on them is the owner's call, and would need an exceptions record per image, as spec 0013 has. |
| D9  | **Secrets live in `~/.univarse/stack/`**, outside the repository: per-role database passwords, the session pepper, Valkey's password, S3 keys, Vault's unseal key and root token, the stack CA's key. Generated by `pnpm stack:init`, owner-only (spec 0017's `writeOwnerOnly`, on that dedicated directory), passed to containers as env files and mounted files; never in the compose file, never printed, never in the repository. After a restart, **the owner unseals Vault** (`pnpm stack:vault unseal`). | **As written.** Mirrors 09 §4.2's "secrets via host files with 0600" and the dev Vault's `.vault-dev.json` pattern, outside git. |
| D10 | **Memory.** The stack runs **instead of** the development services, not beside them. Each container has a memory limit; the sum without ClamAV stays within **3.5 GB** (docs/10 §4.1's 4 GB Docker allocation). ClamAV is a profile, started for the scan check and stopped after. | **As written.** Measured, not guessed: PR A records each container's peak. |

## PR B decisions (revision 2, owner, 2026-10-21)

| #  | Decision |
| -- | -------- |
| B1 | **HSTS is set at the edge.** Caddy sets `Strict-Transport-Security: max-age=63072000; includeSubDomains` on every response it serves, pages and API alike. It **replaces** whatever the upstream sent, so a response never carries two HSTS headers or the API's production value. `preload` stays out of the local stack. **Production's HSTS is a separate, explicit decision before the pilot** (docs/08 §6 lists `preload` today): preloading is hard to reverse, and `includeSubDomains` already commits every subdomain to HTTPS, so before production every affected subdomain must be shown to serve HTTPS, with no legitimate service relying on HTTP. |
| B2 | **The edge CA is UniVarse's own, name-constrained** (changes D5). `pnpm stack:init` makes an edge CA whose certificate permits only `stack.univarse.localhost` and its subdomains (`nameConstraints=critical,permitted;DNS:stack.univarse.localhost`), and one wildcard certificate `*.stack.univarse.localhost` for Caddy. Caddy serves that certificate (`tls <cert> <key>`) and runs no CA of its own. **The edge CA's key never enters a container**; Caddy holds only the wildcard certificate's key. The edge CA is separate from the internal stack CA (D7), so rotating the internal certificates never touches what the owner trusts. Installed in Windows' trust store, it can't vouch for any other name: browsers enforce the constraint. |
| B3 | **The trust step is the owner's, documented both ways.** `pnpm stack:trust` exports the edge CA certificate, prints its SHA-256 fingerprint, and prints the commands to install it in the current user's root store and to remove it. It never runs them. The owner checks the fingerprint before installing. No test disables certificate verification. |
| B4 | **The E2E suite runs against the stack over a temporary loopback tunnel.** Playwright runs on the owner's machine with the OS trust store, so it tests the real browser's trust. For the length of the run only, `pnpm stack:e2e` starts a throwaway forwarder (`alpine/socat`, digest-pinned, UID 65532, read-only, no capabilities, a one-hour lifetime) that publishes **PgBouncer only, on `127.0.0.1` only**. PgBouncer still requires TLS (verified against the stack CA) and SCRAM; PostgreSQL itself is never published. The fixtures get the stack's URLs and pepper from `~/.univarse/stack` through the environment, never printed. The root `.env` is not read in stack mode. The tunnel is removed on success, failure and interrupt, and its absence is then verified: no container, and the port refuses connections. A tunnel left by a killed run is removed by the next run, and by `pnpm stack:down`. Before a run, the launcher clears only the stack's rate-limit counters (`rl:*` in its Valkey), because Caddy rightly ignores the tests' `X-Forwarded-For`, so every test arrives from one address. |
| B5 | **`pnpm stack:pools`.** PgBouncer's admin password joins `secrets.json` (owner-only). The command runs `SHOW POOLS` from a throwaway container on the internal network: no port published, the password passed by environment name, never printed. It fails clearly, naming the cause, if PgBouncer is down or authentication fails. |
| B6 | **PB1 and PB2 through the stack's PgBouncer** (`pnpm stack:isolation`, over B4's tunnel). The stack variant keeps spec 0017's assertions, at the stack's own pool size read from `SHOW CONFIG`:<br>• **PB1:** 20 connected clients share at most `default_pool_size` backends; at least one backend serves two different clients (certain by pigeonhole); a session-level canary set by one client is read by another on the same backend, proving transaction pooling.<br>• **PB2:** two tenants with equal fixture counts and distinct markers; 1 000 interleaved reads over both read paths, each checking ids, the exact values and the count; the check fails on swapped tenants; and after a tenant transaction, a context-free query on the same backend sees no context and no rows.<br>Its fixtures are removed afterwards, exactly, as the superuser inside the PostgreSQL container (`docker exec`, password by environment name). |

## PR C decisions (revision 3, owner, 2026-10-21)

| #  | Decision |
| -- | -------- |
| C1 | **No plaintext Vault in production, with no exception.** In production (`NODE_ENV=production`), every process that builds the `vault` key provider (API, worker, migrate job) refuses a `VAULT_ADDR` that isn't `https://`, at start, loopback included. Development keeps the dev Vault on plain HTTP: the rule is production's. Every place that runs the **production images** against a dev Vault (CI's image E2E, the release's smoke and journeys) moves to a TLS listener on the dev Vault, trusted through `NODE_EXTRA_CA_CERTS`, never by disabling verification. |
| C2 | **The stack's Vault listens only with TLS:** the certificate the internal stack CA already issues for `vault`, TLS 1.2 at least. The app's `VAULT_ADDR` is `https://vault:8200`; it already trusts the stack CA. The Vault CLI inside the container (the deploy's setup, `stack:vault`) and the healthcheck verify against the same CA under the name `vault`. |
| C3 | **A file audit device on its own volume**, enabled by the deploy's Vault setup (idempotent), with Vault's default HMAC of request and response values (`log_raw` off). The smoke makes a Transit wrap and unwrap with the app's own token, under the app's policy and a context of the app's shape, and checks that both appear in the audit log, their values as `hmac-sha256:…`, and that neither the plaintext nor the context appears in clear. The E2E run shows the app's own unwraps audited. |
| C4 | **The fail-closed check runs against a throwaway Vault, never the stack's.** A disposable Vault (the stack's pinned image, its own audit volume, initialised, Transit and the KEK as in the stack) is made unable to write its audit log; then Vault refuses the request, and the app's own provider code (`VaultTransitProvider`, as the API builds it) reports `provider_unavailable`. Restoring the log restores service. It is a test (`tools/stack`, needs Docker). |
| C5 | **PR C splits in two.** **C1:** the stack's Vault on TLS with its audit device, and C4's test: no image change, so no new release. **C2:** C1's refusal in `@univarse/crypto`, the dev Vault's TLS listener for production-image runs, and CI and the release on it; then the owner cuts a new signed release, the stack deploys it, and ADR-018 closes. |

## Acceptance criteria

| ID   | Criterion |
| ---- | --------- |
| LS1  | _The shape (PR A)._ A static test over the stack's compose file, and a runtime check by `docker inspect` after a deploy, show: only the edge publishes ports, and only on `127.0.0.1`; PostgreSQL sits on a `db` network shared only with PgBouncer and the migrate job; the API, worker and web are on `app`; `db` and `data` networks are `internal: true`; every UniVarse container is read-only, UID 65532, `cap_drop: ALL`, `no-new-privileges`, with a tmpfs `/tmp` and a memory limit; no container mounts the Docker socket. **PR B:** Caddy publishes `127.0.0.1:443` and `127.0.0.1:80` only. **The E2E tunnel (B4) is the one exception**, and it exists only while `pnpm stack:e2e` or `pnpm stack:isolation` runs: it publishes PgBouncer on `127.0.0.1` only, never PostgreSQL. After the run, success or failure, no tunnel container exists and the port refuses connections. A test shows the tunnel removed after a failed run. |
| LS2  | _Only digests._ Every image reference in the running stack is `name@sha256:…`. The four UniVarse roles come **only** from the verified record; the stack file names none of them. A test with a tag in place of a digest is refused before anything starts. |
| LS3  | _The deploy (LR9, transferred; blocking)._ `pnpm stack:deploy <record.json> [--commit sha]`: (1) takes the registry lock and holds it until the stack is up or the deploy has failed; (2) runs `verifyRelease` on the record, with the roles and Dockerfiles from trusted code and the commit from the deployment target (`--commit`, else the checkout's `HEAD`; never the record's own value), **before any container is created**; (3) runs exactly the verified digests. **Tests with an edited record** (a changed digest, an extra role, a missing role, a different commit, a rehearsal record, an unsigned image) each fail at verification, create no container, and release the lock. A test holding the lock shows a concurrent `images:prune --apply` and a second deploy are refused. |
| LS4  | _Migrations first (PR A)._ The deploy runs the `migrate` job (migrations for platform and tenant shards, `rls:check`, then the idempotent seed) before starting the API, worker or web; if the job fails, nothing new starts and the previous containers keep running. The job connects to PostgreSQL directly (PB8), never through PgBouncer. |
| LS5  | _PgBouncer in the path (7.1)._ The API and worker reach PostgreSQL **only** through PgBouncer in transaction pooling (they have no route to the `db` network); the worker's relay uses its own role's pool. Client TLS is required: a plaintext connection to PgBouncer is refused. PgBouncer verifies PostgreSQL's certificate against the stack CA. A probe shows `SHOW POOLS` with one pool per role, and spec 0017's PB1 (pooling is real) and PB2 (the tenant context never crosses clients) pass through the stack's PgBouncer at its own pool size (B6), with their negative assertions. `pnpm stack:pools` shows one pool per role without publishing a port, and fails clearly when PgBouncer is down or authentication fails (B5). |
| LS6  | _The smoke check (PR A)._ After every deploy: API health; a tenant request (`/api/v1/tenant/public-profile` on `demo-uni`) answers 200 with its tenant; the worker logged `worker.started` and its relay published a test invalidation; the web app serves `/login`; stdout of the API and worker is JSON lines only. A failed smoke fails the deploy, with the containers' last log lines printed (no secrets: the logger's redaction applies). |
| LS7  | _HTTPS (7.2, PR B)._ Through `https://demo-uni.stack.univarse.localhost`: the certificate chains to the stack's Caddy root; HTTP redirects to HTTPS; responses carry the CSP, with a nonce, and HSTS (`max-age=63072000; includeSubDomains`, **no** `preload`); the session cookie is set `Secure; HttpOnly; SameSite=Lax` with the `__Host-` prefix. **PR B:** the certificate chains to the name-constrained edge CA (B2), and a certificate for a name outside `stack.univarse.localhost` is refused; the HSTS value is exactly `max-age=63072000; includeSubDomains`, **once**, on pages and API responses alike (B1). The Playwright suite (desktop and mobile) runs green **against the stack over HTTPS**, and records no CSP violation. |
| LS8  | _Vault with TLS and audit (7.3, PR C; closes ADR-018)._ Vault listens only with TLS (a certificate from the stack CA), on an internal network. The API and worker run `KEY_PROVIDER=vault`, trusting the stack CA (`NODE_EXTRA_CA_CERTS`), and a plaintext `VAULT_ADDR` is refused at start (**C1: in production, loopback included**; shown by unit tests in C2 and on the stack with the new release). A file audit device is enabled: a DEK wrap and unwrap during the smoke each appear in the audit log, with values HMAC'd, never in clear. With the audit device unwritable, Vault refuses the request, and the API reports the key provider unavailable (fails closed). |
| LS9  | _Secrets (D9)._ `pnpm stack:init` generates every secret into `~/.univarse/stack/`, owner-only (checked as spec 0017's auth file is); a test scans the stack's compose file, the repository and the deploy's output for each generated value and finds none. The stack never reads the root `.env` or `.env.worker`, and never connects to the owner's native PostgreSQL or the dev Vault. **PR B:** the E2E and isolation runs take their database URLs and pepper only from `~/.univarse/stack`, never from the root `.env` (a test shows stack mode refuses to start with them missing, and doesn't read `.env`); no secret is printed. |
| LS10 | _Memory (D10)._ Each container's limit is set; PR A records each one's peak during the smoke and the E2E run; the sum of limits without ClamAV is ≤ 3.5 GB. |
| LS11 | _Evidence._ Every LS ID appears in a test or a recorded check. Mutations, each failing its check: a port published on `0.0.0.0` (LS1); the API given the `db` network (LS1, LS5); a tag in place of a digest (LS2); verification after `up` (LS3: a rejected record would start containers); the lock released before startup (LS3); the migrate job skipped (LS4); PgBouncer's client TLS optional (LS5); HSTS with `preload` or without `includeSubDomains` (LS7); the session cookie without `Secure` (LS7); a certificate outside the edge CA's name constraint (LS7); a second HSTS header left in place (LS7); the tunnel left running after a failed run (LS1); the tunnel bound to `0.0.0.0` (LS1); the probe at the probe profile's pool size, or the swapped-tenant check removed (LS5); stack mode falling back to `.env` (LS9); Vault without TLS (LS8); the audit device disabled (LS8); a generated secret written into the compose file (LS9). |

## Design

**Files** (as built in PR A2; the notes below give the changes from the first design).

- `infra/stack/compose.yml`: the stack. No UniVarse image is named in it: the deploy passes the four verified references to compose as `UNIVARSE_API_IMAGE`, `UNIVARSE_WEB_IMAGE`, `UNIVARSE_MIGRATE_IMAGE` and `UNIVARSE_PGBOUNCER_IMAGE`, and compose refuses to start without them.
- `infra/stack/caddy/Caddyfile`, `infra/stack/vault/stack.hcl`. PgBouncer's configuration, PostgreSQL's `pg_hba.conf`, Valkey's and SeaweedFS's are rendered by the deploy into `~/.univarse/stack/rendered/` and copied into owner-only volumes; nothing secret is in the repository.
- `tools/stack/src/` (TypeScript, run with `tsx`): `init.ts` (`pnpm stack:init [--rotate]`), `deploy.ts` and `deploy-deps.ts` (`pnpm stack:deploy`), `vault.ts` (`pnpm stack:vault status|init|unseal`; since spec 0020 B1 the command's entry point is `vault-cli.ts`, which adds `migrate-raft`, and spec 0023 adds `renew`), `smoke.ts` (`pnpm stack:smoke`), `down.ts` (`pnpm stack:down`, keeps volumes), with `render.ts`, `secrets.ts`, `certs.ts` and `volumes.ts`.
- `infra/docker/migrate.Dockerfile`: the fourth role (PR A1).

**Networks** (as built).

| Network | Internal | Members |
| ------- | -------- | ------- |
| `edge`  | no (publishes `127.0.0.1:80`) | caddy |
| `app`   | yes | caddy (fixed address `172.31.219.10`), web (`172.31.219.11`), api, worker, web, pgbouncer, valkey, seaweedfs, mailpit, vault, clamav, migrate |
| `db`    | yes | postgres, pgbouncer, migrate |

Only Caddy is on `edge`. It reaches the API and web over `app`. The web app's server components call the API over `app`, passing the user's Host as `X-Forwarded-Host`. The API trusts forwarding headers only from Caddy's and the web app's fixed addresses (`TRUSTED_PROXIES`), as in dev, where both are on `127.0.0.1`. Mailpit's UI and SeaweedFS's S3 endpoint are reachable only through Caddy (`mail.stack.univarse.localhost`, `files.stack.univarse.localhost`).

**The deploy, in order** (`tools/stack/src/deploy.ts`; every side effect is a step the tests record).

1. Acquire the registry lock (spec 0013 LR8), holder `deploy`. Everything after this is inside `try … finally`, so the lock is released whatever fails.
2. Start the local registry container if it is stopped (it is stopped again afterwards only if the deploy started it).
3. `verifyRelease(record, { commit: --commit ?? HEAD })` with all four roles. Any problem: print each and exit non-zero. Nothing has been created, written or started.
4. Render the env files and configuration into `~/.univarse/stack/` (owner-only) and fill the volumes. Scan the third-party images (D8) and report.
5. Start Vault. Sealed: stop and ask the owner for `pnpm stack:vault unseal`. First deploy: initialise it. Then complete its setup (Transit, the KEK, the policies, the app and backup tokens; idempotent) and render again with the app token. Since [spec 0023](0023-vault-app-token-renewal.md), this step also re-issues a token Vault says is dead, then renews both tokens. A re-issued app token makes the deploy recreate the API and the worker before the smoke check.
6. Start PostgreSQL and run the `migrate` job. A failed job stops the deploy; nothing new starts.
7. Start SeaweedFS and create the quarantine and clean buckets (idempotent).
8. Start the rest: `docker compose -p univarse-stack -f infra/stack/compose.yml up -d --wait --remove-orphans`.
9. Smoke (LS6), retried for up to 90 s while the services settle. On failure, print the containers' last log lines and exit non-zero, saving no state.
10. Record the running digests, and the two deploys before, in `releases/deploy-state.json` (`images:prune` keeps them).
11. Release the lock.

**The `migrate` image.** Built from the same lockfile; runs as UID 65532 with a read-only root; its command is fixed (`migrate-and-seed`), with the domain (`SEED_DOMAIN=stack.univarse.localhost`) and connection strings from its env file. `rls:check` runs inside it after migrating, and its failure fails the job.

**Vault (PR C).** Single node, file storage on its own volume, TLS listener, `disable_mlock` as in dev (stated), the file audit device on a second volume. (Since spec 0020 B1, Vault uses integrated Raft storage on its own volume, and a stack on file storage is migrated once: see [spec 0020](0020-local-backups-and-shred-ledger.md) B-4.) `stack:vault init` initialises once (one unseal share, like dev), stores the share and root token in `~/.univarse/stack/vault-init.json` owner-only, enables Transit and the KEK, and writes a least-privilege app token for the API and worker.

## Implementation notes (PR A1)

**PR A splits in two.** A1 makes the release produce the four roles; then the owner runs a real `pnpm images:release` (only the owner holds the signing key); A2 builds the stack and its deploy against that real record (verifying needs only the public key, so every LS3 check runs without the owner).

**Decisions made while implementing, for the owner's approval:**

1. **`@univarse/db-ops`, a new package** holding the database operations that run directly against PostgreSQL, never through PgBouncer (spec 0017 PB8): `bootstrap()` (roles, databases, privileges, as a superuser, idempotent; it takes plaintext passwords or SCRAM verifiers), `rlsCheck()` with the capture gate, and `seed()` with a `domain` parameter (D6). They moved out of `packages/db/scripts` so the migrate image runs them compiled, with no `tsx` (whose esbuild Go binary would risk the zero-HIGH gate). They are **not** in `@univarse/db`: PB4's session-SQL guard scans that package's runtime code and rightly refused the bootstrap's DDL; a separate package keeps the guard whole rather than carving an exclusion. `pnpm db:setup`, `rls:check` and `db:seed` are thin wrappers over them (by relative path, so no package cycle).
2. **`@univarse/migrate`** (`apps/migrate`): the job, with its steps injected for unit tests (bootstrap only when its five variables are all given; migrations; rls:check, which fails the job; seed; tenant data keys). It invokes the Prisma CLI's own entry with Node. Its two Prisma configs ship in the image beside the copied migrations.
3. **The image** (`infra/docker/migrate.Dockerfile`): the API's two digest-pinned bases; Prisma's schema engine fetched by its install script and checked against Prisma's published SHA-256; update checks off. **0 HIGH/CRITICAL** (23 MEDIUM and 8 LOW, all from the base, as for the API).
4. **Release roles become four; `verifyRelease` takes the role set.** The deploy always uses all four, so a release from before this spec can never be deployed. **The existing signed release `12083b8` (api, web) stays kept and verifiable:** `pnpm images:prune` re-verifies a kept release against the role set it was signed with (the smallest of the two sets covering its signed roles), and `pnpm images:verify --legacy` re-checks it as signed while stating it isn't deployable.
5. **The release runs per-role gates:** each role's runtime base passes the CS3 check (one digest-pinned `RUNTIME_IMAGE`, the final stage built from it) and each distinct base's upstream signature is verified; inspection uses each image's own root (`usr/bin` for PgBouncer); PgBouncer gets CI's spec 0017 PB10 gates (the inventory, the Grype gate by CPE, the nine coverage controls, the upstream pin); the migrate image gets a functional smoke (`tools/images/migrate-smoke.mjs`, also in CI). The record's schema becomes 3.

**Evidence (local).**

- The migrate image, hardened (read-only, UID 65532, no capabilities), against a disposable PostgreSQL 18: the first run bootstrapped, migrated both schemas, passed rls:check (14 tables, capture intact), seeded `*.stack.univarse.localhost` and created three data keys; the second changed nothing; no generated secret in either output.
- `12083b8`: deploy mode **rejects** it (no migrate, no pgbouncer image); `--legacy` **verifies** both images against `infra/signing/cosign.pub`. `pnpm images:prune` (dry run) keeps it and would verify it as the legacy set.
- Unit: `verify-release` 10, `prune` 28, `release-lib` 3, `migrate-smoke` 2, `@univarse/migrate` 6; PB4's guard passes over the moved code.

## Implementation notes (PR A2)

**Decisions made while implementing, for the owner's approval:**

1. **Networks.** Only Caddy is on `edge`, not the web app and the API as the first design had. Caddy reaches them over `app` from a fixed address, which is the one address the API trusts for `X-Forwarded-*`. There is no separate `data` network: Valkey, SeaweedFS, Mailpit and Vault are on `app`, which is internal. So LS1's "`db` and `data` are internal" holds as "`app` and `db` are internal".
2. **The digests reach compose as variables, not through a `.digests.env` file.** Nothing is written before verification, and no file can go stale. The running digests are recorded after the smoke, in `releases/deploy-state.json`.
3. **The first deploy initialises Vault**, and every deploy completes any missing part of its setup (resumable, idempotent). A sealed Vault stops the deploy before the database, naming the owner's step (`pnpm stack:vault unseal`). PR A's Vault listener is plaintext on the internal `app` network. TLS and the audit device are PR C (LS8).
4. **The registry is started directly** (`docker start univarse-dev-registry-1`), never through the dev compose, so the deploy never reads the root `.env` (LS9).
5. **The D8 scans are cached per digest** in `~/.univarse/stack/scans.json`. The pins change only in a reviewed PR, and rescanning every image on every deploy took minutes. A failed scan is reported and retried next time; scans never block.
6. **A bucket step.** The API and worker need the quarantine and clean buckets, which dev creates after `compose up` (`tools/storage-dev.mjs buckets`). The stack's SeaweedFS publishes no port, so the deploy creates them with `weed shell` inside its container before the API and worker start, and checks the listing (`weed shell` exits 0 even when a command fails).
7. **Caddy keeps one capability, `NET_BIND_SERVICE`.** The official image gives `/usr/bin/caddy` that file capability, and the kernel refuses to exec a binary whose file capabilities exceed the bounding set. Under `cap_drop: ALL` the result was "operation not permitted". Caddy listens on 8080 and never uses the capability. It is the stack's only `cap_add`: `compose.spec` and the smoke's runtime inspection both refuse any other.
8. **Env files escape `$`.** Compose interpolates `$` inside `env_file` values. The SCRAM verifiers are full of `$`, so the first real deploy corrupted them: the migrate job failed authentication, and compose printed verifier fragments as unknown variable names. Every `$` is now written `$$`. A test runs a `$`-heavy value through `docker compose config`. The affected secrets were rotated (`pnpm stack:init --rotate`) and the stack's database volume was reset; the log holding the fragments was deleted.
9. **TLS verification on the database path.**
   - The API and worker connect with `sslmode=verify-full`, through PgBouncer.
   - PgBouncer verifies PostgreSQL (`server_tls_sslmode = verify-full`, the stack CA).
   - The migrate job's URLs said `sslmode=require`, because Prisma's schema engine doesn't accept `verify-full`. **The limit, closed on 2026-10-24** ("Fix: the migrate job verifies PostgreSQL", below): the schema engine's connections (migrations) were encrypted but didn't verify PostgreSQL's certificate. The job's node-postgres connections (bootstrap, `rls:check`, seed, data keys) treated `require` as verify-full and did verify it.
10. **The smoke retries for up to 90 s.** The worker has no healthcheck, so `up --wait` can return before its first pass; the first real smoke ran too early.
11. **The API trusts the web app's forwarding headers too, and the smoke reads the login page.** The owner opened the stack in a browser and got "We couldn't find this institution". The API had trusted only Caddy's address, so it ignored the `X-Forwarded-Host` the web app's server components send, and resolved no tenant. The smoke had passed because that page answers 200. Now:
    - the web app has a fixed address, and the API trusts it as well (still a fixed list, never a blanket "trust all", docs/08 §3.4);
    - the smoke requires `/login` to name the institution (`Demo University`), and not to say "find this institution".

    The stricter smoke failed on the broken stack; after the fix, the redeploy passed, and the page shows "Demo University, Lagos". Both mutations were killed: Caddy alone in `TRUSTED_PROXIES`, and web without its fixed address.
12. **Vault has a healthcheck** (2026-10-21). A redeploy that recreated the Vault container reported "Vault is not reachable" instead of the unseal step: with no healthcheck, `up --wait vault` returned before its listener answered, and `vaultState()` read that as absent. It is now healthy once `vault status` exits 0 or 2 (unsealed or sealed), so the wait means Vault can be read. `compose.spec` holds it; it fails with the healthcheck removed, or with one that rejects a sealed Vault. PR C's TLS listener changes the address it checks.

**Evidence (2026-10-20, local, release `0cf53d8`).**

- **The deploy:** `pnpm stack:deploy releases/2026-10-20-0cf53d8.json` exited 0. It verified the four digests against `infra/signing/cosign.pub`:
  - api `sha256:af11b58c…`
  - web `sha256:c53bcfcb…`
  - migrate `sha256:2ba12ba9…`
  - pgbouncer `sha256:c27b9b0b…`

  The migrate job bootstrapped, migrated, passed `rls:check` and seeded `*.stack.univarse.localhost`. The smoke passed.
- **The deploy's stops, as designed:**
  - a stopped Vault came back sealed, and the deploy refused before the database with the unseal instruction (`pnpm stack:vault unseal`, then deploy again);
  - an earlier run failed the migrate job (finding 8), and nothing new started.
- **LS1 and LS6 through Caddy** (`127.0.0.1:80`, `Host: demo-uni.stack.univarse.localhost`):

  | Request | Status |
  | ------- | ------ |
  | `/health/live` | 200 |
  | `/api/v1/tenant/public-profile` (names `demo-uni`) | 200 |
  | `/login` (names "Demo University, Lagos"; finding 11) | 200 |
  | an unknown tenant | 404 |

  At runtime the smoke's `docker inspect` found no problem. The API, worker, web and PgBouncer run as 65532.
- **LS5:**
  - a plaintext `psql` to PgBouncer from the `app` network was refused with `FATAL: SSL required`;
  - PgBouncer's log shows a separate pool for each role (`univarse_platform/univarse_app_platform`, `univarse_pool_01/univarse_app`, `univarse_platform/univarse_relay_platform`), each with TLSv1.3 on both legs.
- **LS9:** the 32 generated values (passwords, verifier parts, Vault's unseal key and tokens) were searched for in every deploy log, the compose file and the repository's 517 files: **0 hits**.
- **LS10:** idle after the smoke, 575 MiB in all:

  | Service | Memory (MiB) |
  | ------- | ------------ |
  | worker | 149 |
  | api | 138 |
  | seaweedfs | 85 |
  | postgres | 82 |
  | web | 62 |
  | vault | 29 |
  | caddy | 11 |
  | pgbouncer | 9 |
  | mailpit | 7 |
  | valkey | 4 |

  The limits sum to at most 3,584 MB without ClamAV (`compose.spec`).
  SeaweedFS's limit (256 MB) is unchanged by spec 0020's bucket fix (24 volumes, grown one at a time); its memory after that fix is recorded in spec 0020, "Implementation notes (fix: the bucket copy)".
- **LS11 mutations, each killed by its test:**
  - a port on `0.0.0.0`;
  - the API given `db`;
  - a tag in place of a digest;
  - a second capability on Caddy;
  - a secret literal in the compose file;
  - verification after `up`;
  - the lock released before startup;
  - the migrate job skipped;
  - the bucket step skipped;
  - PgBouncer's client TLS optional;
  - the API's URL without `verify-full`;
  - env files with `$` unescaped;
  - the web app's address not trusted, or not fixed (finding 11).
- **Unit:** `@univarse/stack`, 51 tests:

  | File | Tests |
  | ---- | ----- |
  | `deploy.spec` | 18 |
  | `compose.spec` | 14 |
  | `render.spec` | 9 |
  | `secrets.spec` | 5 |
  | `certs.spec` | 5 |

  `compose.spec` needs the Docker CLI, not a running stack.

**Not yet shown, carried to PR B:**

- `SHOW POOLS`: PgBouncer's admin has only a stored verifier, deliberately with no password to log in with;
- spec 0017's PB1 run through the stack's PgBouncer;
- LS10's peak during the E2E run, which runs against the stack over HTTPS in PR B.

## Implementation notes (PR B)

**Decisions made while implementing, for the owner's approval** (B1–B6 above were approved before it):

1. **MFA test users enrol through the app (the owner's choice, 2026-10-21).** The fixtures' direct TOTP enrolment encrypts the secret with the tenant key through Vault, which the tunnel doesn't reach. In stack mode, `makeUser` signs in and makes the enrolment screens' own requests (begin, confirm, sign out) through Caddy, so the server encrypts the secret with its own Vault access. The confirm step's recovery codes serve the `recoveryCode` option. Nothing else is published.
2. **A changed volume restarts the services that read it.** This is a bug in PR A's deploy, found here. The deploy refilled the certificate and configuration volumes but never restarted a running container, so PostgreSQL kept serving its old certificate after the internal CA was reissued: the migrate job failed verification, as it should. A rotation would have left Valkey and PgBouncer on the old secrets the same way. Now:
   - `volumes.json` records each volume's content as filled and as loaded;
   - a volume is filled only when its content changed (or it is missing);
   - the services reading an unloaded volume restart: PostgreSQL before the migrate job, the rest once the stack is up;
   - only then is the content recorded as loaded, so a deploy that stops early (a sealed Vault, a failed job) leaves the restart pending.

   Shown live: the internal CA was reissued under a running stack, and the deploy restarted exactly PostgreSQL, PgBouncer, the API and the worker, and passed.
3. **The smoke makes its own test invalidation**, as LS6 says. PR A's smoke relied on the seed's invalidations, which only a first deploy leaves. It failed honestly once the worker was recreated after they had been relayed. It now inserts and deletes a `tenant_domain` row under a reserved `.invalid` name, as the superuser inside the PostgreSQL container, and waits for the worker to log a relay after that moment.
4. **PgBouncer's certificate names `localhost` and `127.0.0.1` too.** Through the tunnel, node-postgres passes TLS no host for an IP address, so Node checks the name `localhost`. `verify-full` holds; only the stack CA can issue it. The internal certificates carry a version, and an older set is reissued by the next `stack:init`.
5. **The tunnel's forwarder is socat 1.8.1.3.** 1.8.0.3, first chosen, carried CVE-2026-56123, a CRITICAL heap overflow in socat itself (fixed in 1.8.1.2), plus four HIGH in OpenSSL. socat is the listening process, so it was refused rather than reported. 1.8.1.3 had 0 HIGH/CRITICAL on 2026-10-21.
6. **Certificate lifetimes.** The edge CA lasts 825 days and Caddy's certificate 397 days (within what browsers accept). `--rotate` never touches the edge CA, which the owner trusts; `--rotate-edge` replaces it, and then it must be installed again.
7. **`stack:init` upgrades in place.** A `secrets.json` from before PR B gains only PgBouncer's admin password; every other secret is kept, so no database reset is needed.
8. **Before an E2E run, only the rate-limit counters (`rl:*`) in the stack's Valkey are cleared.** Caddy ignores the tests' `X-Forwarded-For`, as production would, so every test arrives from one address.
9. **The stack's ClamAV is fixed and brought level with dev.** It had never run in the stack: PR A defined it but never started it. The E2E run found three gaps:
   - **Capabilities.** Under `cap_drop: ALL` its root entrypoint couldn't take ownership of its database. It keeps `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID` and `SETUID`, a subset of Docker's defaults (dev runs with all of them), so `NET_RAW`, `MKNOD`, `SYS_CHROOT`, `KILL`, `SETPCAP` and the rest stay dropped. It is a third-party image, and `compose.spec` and the smoke's inspection allow exactly that set.
   - **Fail-closed settings.** The stack lacked spec 0010 FU3's settings (`AlertEncrypted*`, `AlertExceedsMax` and the scan limits), so an encrypted or oversized file would have come back clean. They are now set as in dev.
   - **The test signature.** It is copied in as in dev (one extra file beside the normal databases), so `[FU9]`'s detection is real.

   **A stated limit:** freshclam can't update signatures from inside the stack (`app` is internal, with no route out), so ClamAV scans with the signatures shipped in its pinned image. ClamAV still starts only for scan runs (D10), and is stopped after.
10. **`pnpm stack:e2e` passes Playwright's own arguments through** (a file, `-g`, `--project`), dropping a leading `--` that a package script adds.

**Evidence (2026-10-21, local, release `0cf53d8`):**

- **The deploy over HTTPS:**
  - #83's healthcheck made the first deploy stop at "Vault is sealed" (not "not reachable"); after `pnpm stack:vault unseal`, the deploy passed;
  - the smoke verifies the certificate against the edge CA;
  - HSTS appears exactly once, `max-age=63072000; includeSubDomains`, on `/login` and on an API answer;
  - `/login` carries a nonce CSP;
  - plain HTTP answers `308` to the same URL over HTTPS;
  - the relay published the smoke's test invalidation.
- **Live mutations of Caddy's configuration**, each failing the smoke:
  - `preload` added: refused on both responses;
  - `defer` removed: an API answer carried two HSTS headers, the edge's and the API's own `…; preload`. That is exactly what B1 prevents.
- **LS5:**
  - `pnpm stack:pools` showed one pool per role (`univarse_app_platform`, `univarse_relay_platform`, `univarse_app`) and the admin console, with no port published;
  - with PgBouncer stopped, it failed with "PgBouncer is not reachable" (exit 1).
- **B6, `pnpm stack:isolation`:** PB1 and PB2 passed through the stack's PgBouncer, 4 of 4:
  - pooling is real at the stack's pool size;
  - the swapped-tenant check fails;
  - 1 000 interleaved reads each saw exactly their tenant's rows;
  - a context-free query on a tenant's backend saw no context and no rows.

  The fixtures were removed exactly. With PB2's tenant check weakened, the self-check failed (live mutation).
- **LS7, the E2E suite against the stack over HTTPS:** `pnpm stack:e2e` passed **34 of 34** (desktop and mobile, 3.5 min), in the owner's browser trust, with the edge CA installed in their user's root store. That includes the stack-only `[LS7]` test: HSTS exactly once on a page and an API answer, and the session cookie `__Host-`, `Secure`, `HttpOnly`, `SameSite=Lax`, host-only. `[W8]` recorded no CSP violation.

  How it got there:
  - the first run passed 32 of 34; both failures were `[FU9]`, which needs ClamAV (finding 9);
  - the second passed 33 of 34. The failure, `[W9]` on desktop, was a 5-second wait after the MFA code with ClamAV's 3 GB also running, the pattern spec 0012 records on this machine. It didn't recur in 6 repeats or in the final run.

  Memory just after the run, without ClamAV: about 0.95 GiB in all. API 290 MiB, worker 149, Vault 142, SeaweedFS 125, web 110, PostgreSQL 77, the rest under 25 each. ClamAV alone: 950 MiB of its 3 GiB limit.
- **B4, the tunnel:** after every run (the passing ones, and the failing isolation and E2E runs) no tunnel container or network remained, and `127.0.0.1:16432` refused connections.
- **LS11 mutations, each killed by its test:**
  - the edge CA without its name constraint;
  - a second HSTS header, or `preload`, accepted;
  - Caddy published on `0.0.0.0`;
  - the tunnel on `0.0.0.0`, to PostgreSQL, or left after a failed run;
  - stack mode falling back to `.env`, or starting with a setting missing;
  - a changed certificate not restarting PostgreSQL;
  - restarts recorded before they happen;
  - a pending restart forgotten;
  - an unstated capability on any service (exact sets on Caddy and ClamAV).
- **Unit:** `@univarse/stack` has 70 tests; `@univarse/web`'s unit tests include `e2e/env.spec`.

## Implementation notes (PR C1)

**Decisions made while implementing, for the owner's approval** (C1–C5 above were approved before it):

1. **A changed Vault certificate restarts Vault at once.** A restart seals Vault, so it can't wait for the end of the deploy as the other services do. The deploy restarts it right after starting it, records that restart for Vault's volume alone, and stops with the usual "Vault is sealed: run `pnpm stack:vault unseal`". The next deploy doesn't restart it again. Every other pending restart is untouched by that early record.
2. **The audit device comes first in Vault's setup**, so every later setup request is recorded too. It is enabled on an existing Vault by the next deploy (setup is idempotent).
3. **The smoke proves the audit with Vault's own HMACs.** It asks `sys/audit-hash/file` (with the root token, inside the container) for the HMAC of its random test values, and finds exactly those in the log: the wrap's plaintext and context, and the unwrap's returned plaintext. It also checks that neither raw value is anywhere in the last 500 lines.
4. **C4's throwaway Vault runs in server mode, as the stack's.** A dev-mode Vault exits with a panic on `SIGHUP`, even with a writable log, so it can't show the reopen. The test runs the stack's pinned image initialised, unsealed and set up by `vault.ts` itself, with the audit volume its own. It makes the log unwritable by its owner (no capability needed) and sends `SIGHUP` so Vault reopens it. Then Vault answers `500` and the app's provider fails closed, as `provider_unavailable`, after its one retry. Restored, Vault serves again.
5. **`stack:e2e` and `stack:isolation` start Playwright and Vitest with Node directly, never a shell.** On Windows the shell read a `-g "W6|W10"` pattern as a pipe; arguments now arrive exactly as given.

**Evidence (2026-10-21, local, release `0cf53d8`):**

- **The first deploy** recreated Vault on TLS (healthy through the TLS healthcheck) and stopped sealed, as designed. After `pnpm stack:vault unseal`, which now goes over TLS, the deploy passed, its smoke including the audit check.
- **`vault audit list`** shows `file/`.
- **A plain HTTP request to `vault:8200` from the `app` network** got `400 Bad Request`: the listener speaks TLS only.
- **The API and worker** run with `VAULT_ADDR=https://vault:8200`.
- **The E2E suite: 34 of 34** over TLS Vault (desktop and mobile, with ClamAV for `[FU9]`, stopped after). During it, the audit log's `transit/decrypt` entries grew from 2 to 6: the app's own unwraps, after a restart had emptied its key caches, each logged with `hmac-sha256:` values. An earlier run straight after that restart failed two desktop sign-ins at the 5-second wait, a cold start. They passed in 36 of 36 repeats and in the final run.
- **`pnpm stack:isolation`:** 4 of 4.
- **C4, the throwaway Vault:** the app's own DEK wrap and unwrap were found in its audit log as HMACs, never in clear. With the log unwritable, wrap and unwrap each failed as `provider_unavailable`; restored, unwrap returned the 32-byte key.
- **LS11 mutations, each killed:**
  - the listener in plaintext;
  - no TLS minimum;
  - the healthcheck over HTTP;
  - the audit log on no volume of its own;
  - the app reaching Vault over HTTP;
  - the audit check accepting values in clear, or a missing unwrap;
  - no audit device configured;
  - a Vault restart not recorded;
  - an early Vault record clearing every pending restart.
- **Unit:** `@univarse/stack` has 78 tests, `audit-failclosed.spec` included (it needs Docker, as `compose.spec` and `certs.spec` do).

**Still to do, in C2:** C1's refusal of a plaintext `VAULT_ADDR` in production, the dev Vault's TLS listener for the production-image runs, and then a new release.

## Implementation notes (PR C2)

**What it does:**

- **The rule (C1)** is `vaultAddrProblem` in `@univarse/crypto`. `keyProviderFrom` applies it, so the API and worker refuse at start, during Nest's module setup. The migrate job checks it among its environment problems, before any step, because its key step comes last. In production, `http://` is refused for every host, `127.0.0.1`, `localhost` and `[::1]` included; `https://` passes; development and tests are untouched.
- **The dev Vault keeps its plain listener on `127.0.0.1:8200`** for `pnpm dev` and the integration tests, and gains a **TLS listener on `127.0.0.1:8201`**.
  - Its certificate (`IP:127.0.0.1`, `DNS:localhost`) comes from a throwaway dev CA made once by `tools/vault-tls.mjs` (in `pnpm dev:infra`), with the stack's pinned OpenSSL image, offline, into the git-ignored `infra/compose/vault/tls/`.
  - The CA's key is deleted once it has signed.
  - Both listeners carry explicit cluster addresses, because Vault's default (port + 1) would have been the TLS listener's own port.
- **Every production-image run** (the image smoke, the browser journeys, in CI and in `pnpm images:release`) gets `VAULT_ADDR=https://127.0.0.1:8201` and the dev CA, mounted read-only and trusted through `NODE_EXTRA_CA_CERTS`. That's `tools/images/container.mjs`; a run without the dev CA stops at once. The migrate-image smoke uses the local provider in `test` mode, so it's unaffected.
- **The image smoke now also proves the refusal on the real image:** the API and the worker, given the dev Vault's plain listener, each must exit non-zero, naming the rule.
- **CI's `build-test` runs Vault as dev does** (compose, server mode, both listeners; `tools/vault-dev.mjs` initialises and unseals it), not as a dev-mode service. A GitHub Actions service can't take the configuration and certificate files a TLS listener needs. `pgbouncer-isolation` runs no production image, and keeps its service.
- **`pnpm images:release` checks the TLS listener first**, as it checks the signing key: if it doesn't answer and verify against the dev CA, the release stops before building anything, naming `pnpm dev:infra`.

**Evidence (local, 2026-10-21):**

- **The compiled API and worker in production mode, given `http://127.0.0.1:8200`:** each exited 1. The worker logged `VAULT_ADDR must be https:// in production: a plaintext Vault is refused, loopback included (spec 0019 C1)`, and so did the API. The API run had first been made with the worker's `.env.worker`, which the API rightly refuses on its own (spec 0016).
- **The control:** in development mode both kept running until stopped, the rule not mentioned.
- **A throwaway Vault with the new `dev.hcl` and certificate:**
  - `https://127.0.0.1:<port>` verified with the dev CA (HTTP 501, uninitialised);
  - without the CA, Node refused it (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`);
  - the plain listener still answered.
- **The release precondition, on the owner's current dev Vault** (no TLS listener yet): "the dev Vault's TLS listener (https://127.0.0.1:8201) failed: ECONNREFUSED. Run pnpm dev:infra".
- **LS11 mutations, each killed:**
  - loopback exempted;
  - the rule not applied by the factory;
  - the rule applied outside production;
  - the migrate job checking only at its last step;
  - images handed the plain listener;
  - the dev CA not mounted;
  - a run without the dev CA allowed;
  - the dev certificate without `127.0.0.1`;
  - the dev CA's key kept.

**Then:**

1. After the merge, the owner runs `pnpm dev:infra`, which makes the dev CA and recreates the dev Vault with its TLS listener (it unseals it, as always).
2. The owner runs `pnpm images:release`.
3. The stack deploys that release, with no `--commit` override.
4. A short docs change closes ADR-018 with that release's evidence.

**Done (2026-10-22):**

- **The release** of `main` at `f6abefa` passed every gate. Its smoke now includes the refusal: the API and worker images, given the dev Vault's plain listener, each refused to start. Its journeys passed 31 of 32, plus 1 flaky: the first desktop test after the containers started, which passed on its retry.
- **`pnpm images:verify`** verified all four images, signature, SBOM and provenance, against `infra/signing/cosign.pub`.
- **The deploy:** `pnpm stack:deploy releases/2026-10-22-f6abefa.json` passed after one unseal, with no `--commit` override.
- **On the stack,** the deployed API and worker images were started on the `app` network with their own env files and only `VAULT_ADDR=http://vault:8200` changed. Each exited 1, logging the rule. The running services, on `https://vault:8200`, served.

**Found by the release:**

- **A sealed dev Vault passed C2's precondition**, and failed the release at its journeys, an hour in. The precondition now also refuses a sealed or uninitialised dev Vault, naming `pnpm dev:vault` or `pnpm dev:infra`.
- **On this 8 GB machine,** a release beside the running stack and the dev ClamAV starved Docker: the web build stalled, and the engine stopped answering. Before a release, stop the stack (`pnpm stack:down`) and the dev ClamAV; the release starts ClamAV itself for the journeys.

## Fix: the migrate job verifies PostgreSQL (2026-10-24)

PR A2's note 9 left the migrate job's migrations unverified. The fix was measured first. The schema engine (Prisma 7.10.0) and node-postgres were each pointed at a TLS endpoint that answers PostgreSQL's `SSLRequest`, and the test recorded whether the client accepted the certificate. The endpoint served three certificates:
- one signed by a test CA, for the right host name;
- one signed by the test CA, for another name;
- a self-signed one, for the right name.

| URL settings | Schema engine | node-postgres |
|---|---|---|
| `sslmode=require` (what the job had) | accepts a self-signed certificate: **no verification** | (verifies today; libpq's meaning, without verification, in its next major) |
| `sslmode=require&sslcert=<CA>` | accepts another CA's certificate and a wrong name | n/a (`sslcert` is a *client* certificate to libpq and node-postgres) |
| `sslmode=verify-full` | ignored: accepts an unknown CA's certificate | without `sslrootcert`, verifies against Node's trust (NODE_EXTRA_CA_CERTS) |
| `sslmode=verify-full&sslrootcert=<CA>` | ignored, as above | **verifies:** refuses another CA and a wrong name |
| `sslmode=require&sslcert=<CA>&sslaccept=strict` | **verifies:** refuses another CA, a wrong name, and any certificate without `sslcert` | n/a |

So the two clients need different forms, and neither form works for both. Now:
- **The URLs:** `migrate.env`'s five URLs use libpq's form, `sslmode=verify-full&sslrootcert=/ca/ca.crt` (`tools/stack/src/render.ts`). node-postgres verifies with it.
- **The engine's form:** the image's Prisma configs turn that form into the engine's verifying form (`apps/migrate/src/tls.ts`, `schemaEngineUrl`). Any TLS setting it can't make verify stops the job, naming the variable and never the URL. A URL with no TLS settings passes unchanged, for the image's smoke against a disposable plaintext database.
- **Production:** the job refuses any URL that doesn't verify (`envProblems`, before any step).
- **The tests:**
  - every database URL in every env file must say `verify-full`, and every direct one must name the CA (`render.spec.ts`);
  - the translation and the production refusal are tested (`tls.spec.ts`, `job.spec.ts`), with 16 mutations, all killed.
- **End to end:** the built `tls.js` and the shipped Prisma config were run through the real engine against the same endpoint. It accepted the right certificate and refused another CA's and a wrong name. With the old `require` URL, the config refused to load, without printing the URL.
- **Not run here:** no Docker daemon here. The image's smoke and the stack's own deploy are the real-database checks; CI runs the smoke. The change reaches the owner's stack with the next release, because the migrate image changed.

## Affected docs (in the implementation PRs)

- **[10](../10-infrastructure-and-deployment.md):** a "local production-like stack" section: networks, commands, memory, the trust-store step, unsealing.
- **[09](../09-container-security.md) §4.2:** the stack as the reference implementation; the internal-plaintext limit (D7).
- **[08](../08-security.md):** T13 (the signing key) unchanged; the stack CA's key and Vault's unseal share in `~/.univarse/stack/` added to the assets; HSTS/CSP over HTTPS as built.
- **[07](../07-data-and-database.md) §3.5:** PgBouncer in the deployed path, with TLS.
- **[19](../19-decision-log.md):** ADR-015's PgBouncer row and ADR-018 closed; ADR-030's table, rows met.
- **[18](../18-roadmap.md):** items 7.1–7.4 and the three exit criteria.
- **README:** how to start, stop and reach the stack.

## Out of scope

- **Backups and restore, and the shred ledger** (item 7.5): the next spec.
- **LAN access for phones** (D5).
- **TLS for Valkey, SeaweedFS, ClamAV and Mailpit** (D7).
- **High availability, auto-unseal:** single node, manual unseal, stated. (Raft storage came later, single node, with spec 0020 B1.)
- **Blocking on third-party image findings** (D8), unless the owner decides otherwise.
