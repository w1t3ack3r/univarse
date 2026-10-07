# 10 — Infrastructure & Deployment

## 1. Environments

| Env | Purpose | Hosting | Data | Deploys |
|-----|---------|---------|------|---------|
| **local** | Development | Docker Compose on the dev machine (`infra/compose/compose.dev.yml`) + apps via `pnpm dev` | Seed data | — |
| **ci** | Automated tests | Ephemeral compose / Testcontainers in CI runners | Seed + fixtures | Every push |
| **preview** (optional, later) | Per-PR review | Ephemeral namespace | Seed | Per PR |
| **staging** | Pre-prod verification, pilots' UAT, DAST, load tests | Same topology as prod, smaller | Synthetic/anonymised only | Auto on merge to `main` |
| **production** | Live tenants | Managed cloud, multi-AZ | Real | Tagged releases, manual approval |

Environments are isolated from each other: separate cloud accounts/projects (at minimum separate VPCs + IAM), separate secrets, separate registries or registry paths with pull-only credentials.

## 2. Hosting strategy by stage

| Stage | Topology | Why |
|-------|----------|-----|
| Phases 0–2 (build) | Local compose + a single **staging VM** running hardened compose ([09 §4.2](09-container-security.md)) with managed Postgres | Cheap, simple, fast feedback |
| Phases 3–6 (pilot, 1–3 tenants) | **Managed Kubernetes** (small, 3 nodes across AZs) + managed Postgres (HA) + managed Redis + object storage + Cloudflare | HA for real users, the deploy pipeline is exercised before GA |
| GA and growth | Same, with autoscaling, a read replica, more pool shards, dedicated shards for large tenants | Scales horizontally without re-architecture |

**Region choice** `[VERIFY]` with pilot institutions and the NDPA transfer rules ([16](16-compliance-ndpa.md)):
- Option A: AWS `af-south-1` (Cape Town) + Lagos Local Zone / Azure South Africa North. Low latency, mature managed services. Needs a cross-border transfer basis under NDPA.
- Option B: Nigerian data centre/cloud (e.g. Rack Centre, MainOne/Equinix LG, local clouds). Data stays in-country, but managed services are less mature.
- Recommendation: Option A for GA, with a documented transfer basis and DPAs. Keep the architecture cloud-portable (Kubernetes, Postgres, S3 API, Terraform modules per provider) so a tenant that requires in-country hosting can get a **dedicated deployment**.

## 3. Production topology

```mermaid
flowchart TB
    U["Users"] --> CF["Cloudflare\nDNS · CDN · WAF · DDoS · Turnstile"]
    CF --> LB["Cloud load balancer\n(Cloudflare IPs only)"]
    subgraph K8s["Kubernetes cluster — 3 AZs"]
        GW["Gateway API controller\nTLS, on-demand certs for custom domains"]
        WEB["web ×3+ HPA"]
        CON["console ×2"]
        API["api ×3+ HPA"]
        WRK["worker ×2+ scaled on queue depth"]
        PGB["PgBouncer ×2"]
        GOT["Gotenberg ×2"]
        AV["ClamAV ×2"]
        OTEL["OTel collector"]
    end
    LB --> GW --> WEB & CON & API
    WEB --> API
    API & WRK --> PGB --> PG[("Managed PostgreSQL HA\nplatform + pool shards\n+ read replica")]
    API & WRK --> RD[("Managed Redis/Valkey HA")]
    API & WRK --> S3[("Object storage\nversioned, encrypted")]
    WRK --> GOT & AV
    WRK --> EGR["Egress NAT/proxy allowlist"] --> EXT["Paystack · Flutterwave · Remita · SMS · Email"]
    OTEL --> OBS["Grafana Cloud / self-hosted LGTM + Sentry"]
```

## 4. Local development

> **Current state:** see [ADR-015](19-decision-log.md). Postgres runs natively in Phase 0, and dependencies are added to compose as features need them. The list below is the target.

`infra/compose/compose.dev.yml` provides: `postgres` (with `platform` + `pool_01` DBs, roles and extensions via init scripts), `pgbouncer`, `valkey`, `seaweedfs` S3 gateway (+ bucket bootstrap; [ADR-025](19-decision-log.md)), `mailpit` (catches email), `gotenberg`, `clamav`, and an optional `caddy` for `*.univarse.localhost` subdomains.

```bash
pnpm i
pnpm dev:infra        # docker compose -f infra/compose/compose.dev.yml up -d
pnpm db:migrate       # platform + tenant schemas, RLS, grants
pnpm db:seed          # demo tenants: demo-uni, test-poly
pnpm dev              # turbo: web :3000, console :3001, api :8080, worker
```
Browse `http://demo-uni.univarse.localhost:3000`. `*.localhost` resolves to loopback in modern browsers, so no hosts-file edits are needed. Ports are bound to `127.0.0.1` only.

**Traces, optional and off by default ([spec 0012](specs/0012-observability-logs-and-traces.md) D2):**
- **Starting it:**
  - `pnpm dev:traces` starts the **OpenTelemetry Collector** (`otel/opentelemetry-collector-contrib:0.162.0`, compose profile `traces`).
  - It accepts OTLP/HTTP on `127.0.0.1:14318`. That's not 4318, so the no-endpoint test that guards the default port never sees it.
  - It writes JSON lines to `infra/compose/otel/out/traces.jsonl` (git-ignored, rotated at 50 MB × 2).
  - Run the API and worker with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318`.
- **Jaeger:** `pnpm dev:traces:jaeger` also starts **Jaeger** 2.22.0 (profile `jaeger`, in-memory storage) with its UI on `http://127.0.0.1:16686`. This is for local viewing only; CI and deployments never run it.
- **Memory:**
  - **The collector:** limited to 256 MB (`mem_limit`, plus a `memory_limiter` at 200 MiB). It measured **57 MiB** after about 2,200 spans (2026-10-07).
  - **Jaeger:** limited to 512 MB.
  - **On the 8 GB laptop,** start these only when you're looking at traces, and stop them after (`docker compose … stop otel-collector jaeger`), as with ClamAV.
- **CI:** the OB12 step starts the same collector service.

### 4.1 Local resource budget (measured 2026-10-06, spec 0010 FU12; database connections 2026-10-07, ADR-026)
**What was measured:**
- **Stack:** Valkey, Mailpit, Vault, SeaweedFS 4.48 and ClamAV 1.5.4 (fail-closed settings) in Docker; the API and worker on the host.
- **Load:** 12 uploads (four of 4.5 MB) scanned while clean files were downloaded concurrently, with a ClamAV signature `RELOAD` triggered mid-burst. The opt-in test is `apps/api/src/modules/files/files.load.int.spec.ts`.

| Container | Idle | Peak, three runs (3rd on `main` at `3aaf809`) |
|---|---|---|
| ClamAV | 955 MiB | **1,579 / 1,907 / 1,371 MiB** (the reload briefly holds two databases) |
| SeaweedFS | 73 MiB | 380 / 413 / 445 MiB |
| Vault, Valkey, Mailpit | ~60 MiB together | ~70 / ~70 / 76 MiB together |
| **All containers** | ~1.1 GiB | **2,025 / 2,395 / 1,893 MiB** |
| API and worker process (host) | | ~390 / ~390 / 344 MiB |

**In all three runs** (per-run table in spec 0010's completion record):
- **0 container restarts** and **0 failed downloads** (161, 87 and 126 completed);
- all 12 files ended `CLEAN`;
- in run two, 3 scans were **retried** while clamd was reloading. A busy scanner delays files; it never releases them.

**Recommendation:**
- **Docker:** allocate **at least 4 GB**. The highest observed container peak for this workload is 2,395 MiB, plus headroom; 3.8 GB worked here.
- **That figure is not a server size.** It covers one workload of the dev containers. A server's RAM also covers Postgres, the OS, more API and worker instances, and real traffic; it is sized in spec 0008.
- **ClamAV in staging and production:** a **2.5–3 GB** memory limit for its container. Its own guidance of about 4 GB stays the safer default for production nodes.
- These figures replace the earlier "8 GB" estimate.

**Bandwidth:**
- The ClamAV image ships with signatures, but **FreshClam still downloads updates** at start and daily (usually small diffs, sometimes a full database). Observed here: signatures 28136 (2026-09-27) updated to 28144 (2026-10-05) on first start. Image size is not a total download budget.
- `CLAMAV_NO_FRESHCLAMD=true` in `.env` stops updates on a slow link. That is local only, with stale signatures, and never in CI or deployed environments.

**Database connection capacity (measured 2026-10-07, [ADR-026](19-decision-log.md)):**
- **Why:** the OB8 test (`tracing.int.spec.ts`) sent 24 concurrent authenticated `GET /api/v1/files` requests. With spans exported synchronously, some returned 500 with P2028: Prisma's 2 s transaction wait expired while session authentication waited for a connection.
- **Machine:** the dev laptop, an i7-7500U (2 cores, 4 threads) with 8 GB RAM. Before the test it already ran at 100% CPU with 0.9 GB free (IDEs, browsers, the Docker VM). Postgres 18.1 native, one compiled API process (`dist/main.js`). These are a loaded machine's numbers, not a server's.
- **Load:** `apps/api/scripts/load/session-auth.mjs`. Closed loop, 10 s per step, authenticated `GET /api/v1/files`, half `demo-uni` and half `test-poly`, both on `univarse_pool_01`. Each request runs two shard transactions: authentication and the list. "Tracing" means `--import ./dist/otel.js` exporting by batch to a local discard sink.

| Configuration | First step with P2028 (of 16 → 128 concurrent) | Throughput | p95 at 64 concurrent |
|---|---|---|---|
| Pool 10, wait 2 s, no tracing (two runs) | **128** (23 of 521 requests) / none | 32–70 req/s | 2.2–2.4 s |
| Pool 10, wait 2 s, tracing (two runs) | **64** (102 failed) / **32** (17 failed) | 10–45 req/s | 4.4–8.0 s |
| Pool 20, wait 2 s, no tracing / tracing | **16** / **16** | 14–61 / 10–39 req/s | 3.5 / 4.3 s |
| Pool 10, wait 5 s, no tracing / tracing | none / none | 23–64 / 34–72 req/s | 3.9 / 1.6 s |

**What it shows:**
- **The ceiling is the machine, not the pool.** Throughput stays flat as concurrency rises, whatever the settings, and the API process used only about 0.5 cores. A tenant transaction holds its connection about 9–15 ms through Prisma, against 2.7 ms for the same statements over raw `pg`; on a starved CPU every hop between statements grows. Tracing roughly halves throughput here, so P2028 starts 2–4× sooner.
- **A bigger pool fails sooner.** The extra connections are opened under load, inside the 2 s wait. It also raised pg's own "connection timeout" errors.
- **A longer wait only hides the queue.** No refusals, but p95 of 2–4 s with no more throughput. The run-to-run spread (the 5 s/tracing row beat the 2 s/no-tracing rows) is this machine's noise.
- **Session authentication isn't the special case.** About 70% of the P2028s came from the list's batch transaction. Every transaction on a shard shares the same queue.

**Decision ([ADR-026](19-decision-log.md)):** keep 10 connections and the 2 s wait, now explicit. Shed the overflow as **503 `server.busy` + `Retry-After`** instead of a 500 (see [07 §2](07-data-and-database.md)). Add capacity with API replicas and shard resources ([§6](#6-scaling)). Repeat this measurement on the staging hardware before pilot. Its numbers, not these, size the replicas and PgBouncer.

## 5. Deployment process

1. Merge to `main` → CI builds, tests, scans, signs images → **staging deploy** (Helm upgrade, digests pinned) → migration job → smoke tests → e2e subset.
2. Release: tag `vX.Y.Z` → release notes → **manual approval** → prod pipeline:
   1. `MigrationRun` job (expand-phase migrations only; see [07 §4](07-data-and-database.md)) across shards. Stop on failure.
   2. Rolling update (maxUnavailable 0, maxSurge 25%), readiness-gated.
   3. Post-deploy smoke tests (login per tenant type, health, a read on each module).
   4. Automatic rollback (`helm rollback`) if smoke tests fail or the error-rate SLO burns fast in the first 15 min.
3. **Deploy windows:** avoid deploys during tenant-critical windows (registration closing days, result publication days). Tenants' calendar windows are visible to the release checklist. Emergency security fixes are exempt.
4. **Feature flags** decouple deploy from release for risky features and per-tenant rollouts.

## 6. Scaling

| Component | Scaling signal | Limits |
|-----------|---------------|--------|
| web | CPU 60% / RPS | min 3, max 20 |
| api | CPU 60% + p95 latency + `server.busy` (503) rate ([ADR-026](19-decision-log.md)) | min 3, max 30. 10 connections per shard per replica |
| worker | BullMQ queue depth & age (KEDA) | min 2, max 20. Per-queue concurrency caps |
| PgBouncer | Connections | `default_pool_size` tuned so Σ pools < Postgres `max_connections` × 0.8 |
| Postgres | CPU, IOPS, connections | Vertical first. Read replica for reporting. New pool shard at ~50 tenants / 500 GB / sustained CPU > 60% |
| Redis | Memory, ops/s | HA primary/replica. Separate instance for queues if contention appears |

**Pre-scaling for known peaks.** Tenants' result publication and registration-deadline dates come from `CalendarWindow`. The ops calendar pre-scales min replicas the day before (a scheduled job adjusts HPA minimums).

## 7. Backup & disaster recovery

| Item | Method | Frequency / retention |
|------|--------|-----------------------|
| Postgres (all DBs) | Managed PITR (WAL) | Continuous; 35 days prod, 7 days staging |
| Postgres snapshots | Provider snapshot, **copied cross-region**, encrypted. Platform-DB snapshots hold wrapped tenant keys, so this retention sets the crypto-erasure boundary (up to 12 months, [spec 0006](specs/0006-envelope-encryption.md)) | Daily; 35 days, monthly kept 12 months |
| Per-tenant logical export | Worker job: `COPY … WHERE tenant_id = $1` for all tables **except `tenant_data_key`** (wrapped keys never go into object-locked archives, [spec 0006](specs/0006-envelope-encryption.md) destruction boundary) → encrypted archive → backup bucket (different account, object lock) | Nightly; 30 days, monthly 12 months |
| Object storage | Versioning + cross-region replication + object lock (compliance mode) on the backup bucket | Continuous |
| Redis | Not a system of record (sessions are re-creatable; queues rebuilt from outbox) | AOF for durability of in-flight jobs |
| Secrets / config | Secret manager versioning. IaC in git | — |

**Targets:** RPO ≤ **15 min** (PITR typically gives < 5), RTO ≤ **4 h** for full-region loss, ≤ **1 h** for a single-tenant logical restore.

**Drills:**
- Quarterly: restore the prod snapshot into an isolated environment, run the verification suite, record the timings.
- Semi-annually: a single-tenant restore rehearsal and a region-failover tabletop.
- Drill results are logged in `docs/ops/drills/`.

## 8. Networking & DNS

- DNS is on Cloudflare. `*.univarse.ng` → edge. `console.univarse.ng` has a Cloudflare Access / IP allowlist rule. `api.univarse.ng` is for webhooks only.
- Custom domains: the tenant creates a CNAME to `edge.univarse.ng` + a TXT verification record. The gateway issues on-demand TLS **only** for hostnames present and verified in `TenantDomain` (`ask` endpoint check).
- The origin accepts traffic **only from Cloudflare IP ranges** (or via Cloudflare Tunnel). Authenticated origin pulls (mTLS between Cloudflare and the origin) are enabled.
- Private subnets for the cluster and data services. Only the load balancer is public.

## 9. Cost awareness (pilot scale, indicative)

Keep a monthly cost dashboard per environment. The biggest levers are managed Postgres size, NAT/egress, log volume (sample debug logs, keep the info level lean) and SMS (charged per tenant). Review before each phase.

## 10. Operational documents to maintain (`docs/ops/`)

- `runbooks/*.md` (see [14 §6](14-observability-and-operations.md))
- `drills/YYYY-MM-*.md`
- `oncall.md` (rota, escalation, contacts)
- `release-checklist.md`
- `tenant-onboarding-checklist.md`
- `tenant-offboarding-checklist.md`
