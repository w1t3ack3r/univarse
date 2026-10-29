# Spec 0027: Phase 1's S1, the console's shell

**Status:** **Approved by the owner on 2026-10-29, all as written:** P1 to P10.
**Phase:** 1, slice **S1** of [spec 0025](0025-phase-1-control-plane.md) (A1, A2, A6, A11).
**Builds on:**

- [spec 0025](0025-phase-1-control-plane.md): A1 (a separate platform API process), A2 (the `univarse_console` role, no tenant database access), A6 (the allowlist at the edge and in the app), A11 (the fifth signed image);
- [spec 0026](0026-phase-1-start-threat-model-and-storybook.md): the rows this slice answers, **T28** (the console and the tenants can't take each other down) and the host and cookie half of **T23**;
- [ADR-007](../19-decision-log.md) and [02 §4](../02-architecture.md): a separate host, cookie and CSP; platform identities never in tenant databases;
- [ADR-020](../19-decision-log.md): one image, several runtime roles (the worker is one already);
- [spec 0019](0019-local-production-stack.md): the stack's edge, deploy, smoke and memory limits; [spec 0013](0013-container-images-scan-sign.md): the release, its gates and verification;
- **an earlier draft, folded in:** another session's "spec 0025: console foundations" (2026-10-28, branch `docs/spec-0025-console-foundations`, never merged). Its C1 (the platform API as a runtime role of the same image), C2 (reserved names, each side refusing the other), C3 (404, not 403) and C9 (the platform bar, no placeholder sections) are here. Its C4 to C8 (identity, MFA, the invite command, permissions, audit) and its WebAuthn question go to S2's spec.

## Why

S1 builds the place the console lives, before anything lives in it: its own host, its own API process, its own database role, its own signed image, and the walls between it and the tenants. Every later slice (identity, the registry, provisioning) is built inside these walls, so they have to be right first, and proven by tests, not by the absence of features.

S1 delivers no feature a staff member uses. That's deliberate: the shell is released and deployed on its own, so a mistake in the release pipeline's fifth image, the edge, or the allowlist is found while nothing depends on it.

## A measurement that changed the plan

**On the owner's machine (2026-10-29):** a connection to a port Docker publishes on `127.0.0.1` reaches the container from **Docker's gateway address** (`172.17.0.1` on the default network), not from `127.0.0.1`. A throwaway container that answered with the address it saw showed it.

So an edge allowlist of `127.0.0.1`, as the earlier draft proposed, would refuse the owner. P4 below is built on the measurement.

## Decisions for approval

| # | Decision | Recommendation, and the alternative |
| --- | --- | --- |
| P1 | **The platform API is a runtime role of the verified API image:** a new entrypoint `dist/platform.js`, beside `main.js` and `worker.js`, run as its own container `platform-api`. The platform module is mounted only there; the tenant API's controller list never contains a platform controller (a test asserts it). | The tenant API process can't serve a platform route, even by a forgotten guard (T28). No new API image: the release's API digest runs all three roles. Alternative: a separate API image. Rejected: a second build and signature of the same code. |
| P2 | **Hosts and reserved names.** The console is `console.stack.univarse.localhost` on the stack and `console.univarse.localhost:3001` in development. A **reserved-names list** in `packages/domain` (`console`, `api`, `files`, `mail`, `www`, `admin`, `status`, `auth`, `static`, `platform`) that no tenant slug or domain can take: the tenant resolver never resolves one, and a test checks no tenant holds one. | Without it, a tenant could be given the console's own name (T25's look-alike case starts here). Provisioning (S5) refuses them at creation. |
| P3 | **Each side answers 404 for the other's routes.** On the edge, the console's site block sends `/api/platform/*` to `platform-api` and everything else to `console`; tenant hosts never reach `platform-api`. The tenant API answers 404 for `/api/platform/*`, and `platform-api` answers 404 for anything but `/api/platform/v1/*` and `/health/*`. | Three independent walls (edge, tenant API, platform API), each tested on its own. |
| P4 | **The allowlist, at the edge and in the app, answering 404.** Caddy's `remote_ip` matcher on the console's site; anything outside gets **404**, as an unknown host does, never 403, so the console's existence isn't confirmed. `platform-api` checks the client address again, reading `X-Forwarded-For` only from Caddy's fixed address (as the tenant API does). **Locally, the allowlist is the edge network's gateway:** the `edge` network gets a fixed subnet (like `app`), so its gateway is known, and that one address is allowed. What actually keeps the console private on this machine is that Caddy's ports are bound to `127.0.0.1`; the allowlist is the second wall, and the one production relies on. | Measured, not assumed (above). Alternative: `127.0.0.1`. Rejected: it would refuse the owner. The test of a refusal: a container joined to the `edge` network gets its own address, not the gateway, and must get 404 from both layers. |
| P5 | **The `univarse_console` database role,** made by the bootstrap like the other roles, its password in the stack's secrets and its verifier in PgBouncer's `auth_file`. In S1 it can connect to the platform database and nothing more; each later slice grants exactly the tables it needs, in its own migration. **It has no `CONNECT` on any tenant database**, and a test asserts it on every database the bootstrap knows. | Spec 0025 A2 and exit criterion 6. Grants grow slice by slice, so each is reviewed with the code that needs it. |
| P6 | **`apps/console`: Next.js 16 on `packages/ui`,** with its own nonce CSP (as `apps/web`'s `proxy.ts`), the `__Host-uv_console_sid` name reserved with `SameSite=Strict` (spec 0026 T-B; no session exists until S2), and a persistent **"UniVarse platform" bar in deep green** with an environment banner (**LOCAL**). In S1 it serves **one page: the frame and a plain notice that sign-in arrives with S2**, plus its 404. No navigation, no sections, no mock data. | The frame proves the CSP, the fonts, the banner and the edge through a real browser, with axe, before S2 adds the sign-in. Alternative: serve nothing but 404 until S2. Rejected: the E2E and accessibility checks would have nothing to load. |
| P7 | **The fifth image, `univarse-console`,** built like the web image (standalone output, the same pinned distroless base), with role `console` in the release's role table: provenance, signing, verification, the gates and their proofs, the SBOM and T30's check, the deploy and the smoke. **Older four-role releases still verify** (the role sets gain the four-role set, as the two-role set was kept for spec 0019). | Spec 0025 A11. The pipeline treats it exactly like the others; nothing is special-cased. |
| P8 | **Memory, measured.** `platform-api` and `console` start at a `mem_limit` of 384 MiB each, then the owner's deploy measures their real use, and the limits and docs/10's budget are set from it. | The machine has 8 GB; the stack already runs eleven containers. Alternative: guess. Rejected: the release has stalled on memory before. |
| P9 | **Development:** `pnpm dev` also starts `platform-api` on :8081 and the console on :3001; the dev edge routes `console.univarse.localhost` like the stack's edge. | The same walls in development, so a route that only works in dev can't exist. |
| P10 | **Two PRs, one release.** **A:** `platform-api`, the reserved names, the 404 walls, the role, the console app, development. **B:** the console image in the release, deploy, the edge's console block and allowlist, the smoke. The owner releases and deploys once, after B. | A is reviewable without touching the release pipeline; B changes the pipeline alone, and the release proves it. |

## Acceptance criteria

1. The tenant API serves no `/api/platform/*` route (404), and its controller list holds no platform controller; `platform-api` serves only `/api/platform/v1/*` and `/health/*` (404 otherwise). Integration tests for both.
2. No tenant resolves on a reserved name, and no seeded tenant holds one.
3. `univarse_console` connects to the platform database, and has no `CONNECT` on any tenant database (a test on every database).
4. On the stack: the console's frame loads over HTTPS from the owner's browser; a container on the `edge` network gets **404 from Caddy, and 404 from `platform-api`** when it reaches it with a forwarded address outside the allowlist; a tenant host never reaches `platform-api`.
5. The console's E2E (desktop and mobile): the frame, the LOCAL banner, axe clean, a CSP header with a nonce, and no inline script without it.
6. Five images released, signed, verified (`pnpm images:verify`) and deployed; the smoke covers the console; a four-role release still verifies.
7. The two containers' memory measured on the owner's stack, and the limits set from it.
8. Mutation checks on every wall: each removed wall fails a test.

## The owner's steps

- ~~Approve P1 to P10.~~ Done on 2026-10-29.
- After PR B merges: `pnpm images:release`, then `pnpm stack:deploy` (the usual preparation: the stack down, the dev ClamAV stopped, the dev Vault unsealed). Then open `https://console.stack.univarse.localhost` once, to see the frame.

## Affected docs (in the implementation PRs)

- [02 §4–5](../02-architecture.md): the `platform` runtime role, `apps/console`;
- [06 §1](../06-api-guidelines.md): the platform API's hosts, locally and in development;
- [07](../07-data-and-database.md): `univarse_console`;
- [10](../10-infrastructure-and-deployment.md): the console host, the allowlist and what protects it locally, the two containers, the fifth image, the memory budget;
- [12](../12-testing-strategy.md): the walls' tests and the console's E2E;
- [18](../18-roadmap.md): S1's status; [19](../19-decision-log.md): an ADR for P1 and P4 (the platform role, and the measured allowlist).

## Out of scope

Everything a staff member does: signing in, sessions, staff (S2). Any platform table grant beyond connecting (each later slice). Production's allowlist values (hosting).
