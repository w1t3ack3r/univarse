# Spec 0019: The local production-like stack — verified digests, PgBouncer, HTTPS edge, Vault with TLS

**Status:** **Accepted (2026-10-18)** by the owner: revision 1, D1–D10 as written. Implementation in progress: PR A (the stack, its deploy, PgBouncer).
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

## Acceptance criteria

| ID   | Criterion |
| ---- | --------- |
| LS1  | _The shape (PR A)._ A static test over the stack's compose file, and a runtime check by `docker inspect` after a deploy, show: only the edge publishes ports, and only on `127.0.0.1`; PostgreSQL sits on a `db` network shared only with PgBouncer and the migrate job; the API, worker and web are on `app`; `db` and `data` networks are `internal: true`; every UniVarse container is read-only, UID 65532, `cap_drop: ALL`, `no-new-privileges`, with a tmpfs `/tmp` and a memory limit; no container mounts the Docker socket. |
| LS2  | _Only digests._ Every image reference in the running stack is `name@sha256:…`. The four UniVarse roles come **only** from the verified record; the stack file names none of them. A test with a tag in place of a digest is refused before anything starts. |
| LS3  | _The deploy (LR9, transferred; blocking)._ `pnpm stack:deploy <record.json> [--commit sha]`: (1) takes the registry lock and holds it until the stack is up or the deploy has failed; (2) runs `verifyRelease` on the record, with the roles and Dockerfiles from trusted code and the commit from the deployment target (`--commit`, else the checkout's `HEAD`; never the record's own value), **before any container is created**; (3) runs exactly the verified digests. **Tests with an edited record** (a changed digest, an extra role, a missing role, a different commit, a rehearsal record, an unsigned image) each fail at verification, create no container, and release the lock. A test holding the lock shows a concurrent `images:prune --apply` and a second deploy are refused. |
| LS4  | _Migrations first (PR A)._ The deploy runs the `migrate` job (migrations for platform and tenant shards, `rls:check`, then the idempotent seed) before starting the API, worker or web; if the job fails, nothing new starts and the previous containers keep running. The job connects to PostgreSQL directly (PB8), never through PgBouncer. |
| LS5  | _PgBouncer in the path (7.1)._ The API and worker reach PostgreSQL **only** through PgBouncer in transaction pooling (they have no route to the `db` network); the worker's relay uses its own role's pool. Client TLS is required: a plaintext connection to PgBouncer is refused. PgBouncer verifies PostgreSQL's certificate against the stack CA. A probe shows `SHOW POOLS` with one pool per role, and spec 0017's PB1 (RLS context stays transaction-local) passes through the stack's PgBouncer. |
| LS6  | _The smoke check (PR A)._ After every deploy: API health; a tenant request (`/api/v1/tenant/public-profile` on `demo-uni`) answers 200 with its tenant; the worker logged `worker.started` and its relay published a test invalidation; the web app serves `/login`; stdout of the API and worker is JSON lines only. A failed smoke fails the deploy, with the containers' last log lines printed (no secrets: the logger's redaction applies). |
| LS7  | _HTTPS (7.2, PR B)._ Through `https://demo-uni.stack.univarse.localhost`: the certificate chains to the stack's Caddy root; HTTP redirects to HTTPS; responses carry the CSP, with a nonce, and HSTS (`max-age=63072000; includeSubDomains`, **no** `preload`); the session cookie is set `Secure; HttpOnly; SameSite=Lax` with the `__Host-` prefix. The Playwright suite (desktop and mobile) runs green **against the stack over HTTPS**, and records no CSP violation. |
| LS8  | _Vault with TLS and audit (7.3, PR C; closes ADR-018)._ Vault listens only with TLS (a certificate from the stack CA), on an internal network. The API and worker run `KEY_PROVIDER=vault`, trusting the stack CA (`NODE_EXTRA_CA_CERTS`), and a plaintext `VAULT_ADDR` is refused at start. A file audit device is enabled: a DEK wrap and unwrap during the smoke each appear in the audit log, with values HMAC'd, never in clear. With the audit device unwritable, Vault refuses the request, and the API reports the key provider unavailable (fails closed). |
| LS9  | _Secrets (D9)._ `pnpm stack:init` generates every secret into `~/.univarse/stack/`, owner-only (checked as spec 0017's auth file is); a test scans the stack's compose file, the repository and the deploy's output for each generated value and finds none. The stack never reads the root `.env` or `.env.worker`, and never connects to the owner's native PostgreSQL or the dev Vault. |
| LS10 | _Memory (D10)._ Each container's limit is set; PR A records each one's peak during the smoke and the E2E run; the sum of limits without ClamAV is ≤ 3.5 GB. |
| LS11 | _Evidence._ Every LS ID appears in a test or a recorded check. Mutations, each failing its check: a port published on `0.0.0.0` (LS1); the API given the `db` network (LS1, LS5); a tag in place of a digest (LS2); verification after `up` (LS3: a rejected record would start containers); the lock released before startup (LS3); the migrate job skipped (LS4); PgBouncer's client TLS optional (LS5); HSTS with `preload` or without `includeSubDomains` (LS7); the session cookie without `Secure` (LS7); Vault without TLS (LS8); the audit device disabled (LS8); a generated secret written into the compose file (LS9). |

## Design

**Files** (as built in PR A2; the notes below give the changes from the first design).

- `infra/stack/compose.yml`: the stack. No UniVarse image is named in it: the deploy passes the four verified references to compose as `UNIVARSE_API_IMAGE`, `UNIVARSE_WEB_IMAGE`, `UNIVARSE_MIGRATE_IMAGE` and `UNIVARSE_PGBOUNCER_IMAGE`, and compose refuses to start without them.
- `infra/stack/caddy/Caddyfile`, `infra/stack/vault/stack.hcl`. PgBouncer's configuration, PostgreSQL's `pg_hba.conf`, Valkey's and SeaweedFS's are rendered by the deploy into `~/.univarse/stack/rendered/` and copied into owner-only volumes; nothing secret is in the repository.
- `tools/stack/src/` (TypeScript, run with `tsx`): `init.ts` (`pnpm stack:init [--rotate]`), `deploy.ts` and `deploy-deps.ts` (`pnpm stack:deploy`), `vault.ts` (`pnpm stack:vault status|init|unseal`), `smoke.ts` (`pnpm stack:smoke`), `down.ts` (`pnpm stack:down`, keeps volumes), with `render.ts`, `secrets.ts`, `certs.ts` and `volumes.ts`.
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
5. Start Vault. Sealed: stop and ask the owner for `pnpm stack:vault unseal`. First deploy: initialise it. Then complete its setup (Transit, the KEK, the policy, the app token; idempotent) and render again with the app token.
6. Start PostgreSQL and run the `migrate` job. A failed job stops the deploy; nothing new starts.
7. Start SeaweedFS and create the quarantine and clean buckets (idempotent).
8. Start the rest: `docker compose -p univarse-stack -f infra/stack/compose.yml up -d --wait --remove-orphans`.
9. Smoke (LS6), retried for up to 90 s while the services settle. On failure, print the containers' last log lines and exit non-zero, saving no state.
10. Record the running digests, and the two deploys before, in `releases/deploy-state.json` (`images:prune` keeps them).
11. Release the lock.

**The `migrate` image.** Built from the same lockfile; runs as UID 65532 with a read-only root; its command is fixed (`migrate-and-seed`), with the domain (`SEED_DOMAIN=stack.univarse.localhost`) and connection strings from its env file. `rls:check` runs inside it after migrating, and its failure fails the job.

**Vault (PR C).** Single node, file storage on its own volume, TLS listener, `disable_mlock` as in dev (stated), the file audit device on a second volume. `stack:vault init` initialises once (one unseal share, like dev), stores the share and root token in `~/.univarse/stack/vault-init.json` owner-only, enables Transit and the KEK, and writes a least-privilege app token for the API and worker.

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
   - The migrate job's URLs say `sslmode=require`, because Prisma's schema engine doesn't accept `verify-full`. **The limit:** the schema engine's connections (migrations) are encrypted but don't verify PostgreSQL's certificate. The job's node-postgres connections (bootstrap, `rls:check`, seed, data keys) treat `require` as verify-full and do verify it, until node-postgres's next major version changes that. Both legs are on the internal `db` network.
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
- **High availability, auto-unseal, Raft:** single node, manual unseal, stated.
- **Blocking on third-party image findings** (D8), unless the owner decides otherwise.
