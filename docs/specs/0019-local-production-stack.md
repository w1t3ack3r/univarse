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

**Files.**

- `infra/stack/compose.yml`: the stack. No UniVarse image is named in it; the deploy writes `infra/stack/.digests.env` (git-ignored) from the verified record, and the compose file reads `${UNIVARSE_API_IMAGE}` and the others from it.
- `infra/stack/caddy/Caddyfile`, `infra/stack/pgbouncer/` (rendered by `stack:init` from spec 0017's renderer), `infra/stack/vault/stack.hcl`.
- `tools/stack/init.mjs` (`pnpm stack:init`), `tools/stack/deploy.mjs` (`pnpm stack:deploy`), `tools/stack/vault.mjs` (`pnpm stack:vault init|unseal|status`), `tools/stack/smoke.mjs`, `tools/stack/down.mjs` (`pnpm stack:down`, keeps volumes).
- `infra/docker/migrate.Dockerfile`: the fourth role.

**Networks.**

| Network | Internal | Members |
| ------- | -------- | ------- |
| `edge`  | no (publishes 127.0.0.1:80/443) | caddy, web, api |
| `app`   | yes | api, worker, web, pgbouncer, valkey, seaweedfs, mailpit, clamav, vault |
| `db`    | yes | pgbouncer, postgres, migrate |

The worker never joins `edge`. The web app reaches the API over `app` (`API_INTERNAL_URL`); Caddy reaches both over `edge`. Mailpit's UI is reachable only through Caddy at `https://mail.stack.univarse.localhost`, so codes can be read without a published port.

**The deploy, in order.**

1. Acquire the registry lock (spec 0013 LR8), holder `deploy`.
2. Read the record; `verifyRelease(record, { commit: --commit ?? HEAD })`, with the roles and Dockerfiles from the checkout's `ROLES`. Any problem: print each, release the lock, exit non-zero. Nothing has been created.
3. Write `.digests.env` with the four verified references.
4. Scan third-party images (D8), report.
5. Start PostgreSQL (if not running) and run the `migrate` job; wait for success.
6. Start the rest: `docker compose -f infra/stack/compose.yml --env-file infra/stack/.digests.env up -d --wait`. Replaced containers stop as their successors start; locally, a short gap is acceptable.
7. Smoke (LS6). On failure, print logs, exit non-zero (the new containers stay for inspection; the previous digests are recorded in `.digests.prev.env` for a manual roll back with the same command and the previous record).
8. Release the lock.

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
