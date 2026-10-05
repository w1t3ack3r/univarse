# Spec 0008 — Staging environment (planning; decisions needed before build)

**Status:** Draft for decision (2026-10-05). Owner direction: AWS Cape Town is **tentative** until a complete monthly estimate exists; the estimate uses the **current Vault integration**. D1–D6 still open, and only the owner can decide them · **Phase:** 0 exit gate · Builds on [10 §1–2, §7](../10-infrastructure-and-deployment.md), [09 §3–5](../09-container-security.md) and [ADR-023](../19-decision-log.md).

## Why now
Four Phase 0 exit criteria can only be met on a deployed environment:
- CSP and HTTPS cookies verified **on staging**;
- signed images with zero high/critical findings;
- an automatic deploy from `main`;
- ADR-018 closed, which happens once staging runs the `vault` key provider.

Application work continues meanwhile: settings, the API isolation route sweep, file uploads, then OpenAPI. Agreeing these decisions now means the infrastructure is ready by the time that queue reaches staging.

## What staging must prove (acceptance criteria, built after D1–D6)

| ID | Acceptance criterion |
|----|----------------------|
| SG1 | *Same shape as production, smaller* ([10 §1](../10-infrastructure-and-deployment.md)). The edge (TLS) runs in front of web, API and worker, with PostgreSQL 18 (platform + one pool shard), Valkey, Vault and Mailpit-style mail capture. **Synthetic or anonymised data only.** |
| SG2 | *Real TLS.* A tenant host such as `demo-uni.staging.<domain>` serves only HTTPS with HSTS. `__Host-` cookies are `Secure`, `HttpOnly` and `SameSite`. The CSP is enforced (not report-only) with per-request nonces. Tested by an automated check against staging. |
| SG3 | *Automatic deploy from `main`.* A merge builds images, scans them (0 high/critical), produces an SBOM, signs them, deploys, runs migrations, and runs a smoke E2E. A failed smoke run stops the deploy and alerts. |
| SG4 | *Secrets.* No secrets in the repo or in images. Runtime secrets come from the provider's secret manager. The Vault app token and the Postgres app-role passwords are separate per environment. |
| SG5 | *Vault in a staging-grade setup* (D4). It is unsealed automatically or by a documented procedure, uses TLS, has its audit device on and takes daily snapshots. The app token can only encrypt and decrypt, and the key-admin token is held outside the app host. **ADR-018 closes here.** |
| SG6 | *Backups and restore* ([10 §7](../10-infrastructure-and-deployment.md)): Postgres point-in-time recovery (7 days for staging) and one rehearsed restore. The restore runbook **re-applies crypto-shreds** from a ledger outside the platform DB ([spec 0006](0006-envelope-encryption.md), destruction boundary). |
| SG7 | *Host hardening* ([09 §4.2, §5](../09-container-security.md)): SSH by key only, a firewall that lets in only the edge, unattended security updates, non-root containers with read-only root filesystems and dropped capabilities. |
| SG8 | *Cost guard.* Monthly spend stays under the D1 ceiling, with a billing alert at 80%. |

## Resource plan: what staging hosts and what it needs (estimate input)
**Assumptions:** synthetic data; a handful of testers plus the automated smoke E2E after each deploy; no load tests (those run later on temporarily larger instances). The memory figures are planning ranges. They are confirmed by measuring the containers on the first deploy.

### App host (one VM)
| Container | CPU (steady / burst) | Memory | Notes |
|---|---|---|---|
| Edge (TLS behind Cloudflare, routes `/api`) | ~0.05 / 0.2 vCPU | ~64 MB | |
| `web` (Next.js standalone) | 0.1 / 0.5 | 300–500 MB | Server rendering |
| `api` (NestJS/Fastify) | 0.1 / 0.5 | 250–400 MB | Argon2 hashing is the CPU spike on sign-in |
| `worker` (outbox + key sweep) | 0.05 / 0.25 | 200–300 MB | |
| Valkey | 0.05 | 64–128 MB | `maxmemory 128mb`; sessions, rate limits, settings invalidation |
| PgBouncer | ~0 | ~32 MB | Same shape as production |
| Mail capture (Mailpit) | ~0 | ~64 MB | Staging never sends real email |
| OTel collector (when observability lands) | 0.05 | 100–200 MB | |
| **ClamAV** (when file uploads land) | 0.2 / 1 | **1.5–3 GB** | Signature database is held in memory and briefly doubles on reload. The largest single item |
| **Gotenberg** (PDFs, later) | 0 / 1 | 0.5–1 GB per conversion | Chromium; bursty |
| **Total** | **2 vCPU** | ~1.5 GB now; ~4–5 GB with ClamAV and Gotenberg | **8 GB RAM** gives headroom for reloads and the smoke run |

- **Disk:** 40 GB gp3 root. It holds images (~3–5 GB), ClamAV signatures (~1 GB), and rotated logs. No tenant data lives on the host.
- **Instance class:** a 2 vCPU / 8 GB general-purpose instance. Burstable is acceptable for staging if it can't throttle hard during ClamAV reloads and E2E runs. The exact class is checked for `af-south-1` availability in the estimate.

### Vault host (separate small VM, D4)
- 2 vCPU burstable, 1–2 GB RAM, 20 GB gp3. Raft data is tiny; snapshots go to S3 daily.
- Auto-unseal through one KMS key. TLS, audit device on.

### Managed PostgreSQL 18 (D3)
- **Instance:** 2 vCPU / 4 GB, Single-AZ for staging. Two databases: platform and `univarse_pool_01`.
- **Storage:** 20 GB gp3 with autoscaling (data is MBs; the floor is the provider minimum). PITR 7 days.
- **Connections:** the API keeps idle connections for 5 min, so PgBouncer sits in front once it's in place. `max_connections` is comfortably above our pools.

### Storage, keys and platform services
| Service | Expected size | Purpose |
|---|---|---|
| S3: uploads bucket | < 5 GB | Synthetic files (when the files module lands) |
| S3: backup/ledger bucket (object lock) | < 10 GB | Destruction ledger, exports, Vault snapshots |
| Container registry (ECR) | 5–10 GB | ~5 images, keep the last 10 tags |
| KMS | 1–2 keys | Vault auto-unseal; S3/RDS encryption |
| Secrets Manager | ~10 secrets | DB role passwords, Vault app token, session pepper, SMTP, … |
| CloudWatch Logs | 5–10 GB/month | 14-day retention |
| Egress | < 50 GB/month | Behind Cloudflare; few users |

### Networking
- One VPC with RDS and the Vault VM in private subnets. The app VM accepts 443 only from Cloudflare IP ranges, plus SSH by key from an allow-list (or SSM instead of SSH).
- **Cost trap:** a NAT gateway costs more per month than several small VMs. Prefer VPC endpoints (S3, ECR, Secrets Manager, KMS, Logs) and no NAT. The estimate prices both.
- **Domain:** use a separate staging domain, so tenant hosts are first-level wildcards (`demo-uni.<staging-domain>`).
  - **Certificates:** Cloudflare's free Universal SSL covers `*.<domain>` but **not** `*.staging.<domain>` (second level); that would need a paid certificate add-on.
  - **Cookies:** a separate domain also keeps staging cookies apart from production.

### CI/CD
- GitHub Actions builds, scans, signs and pushes the images, then deploys with an **OIDC role**, so there are no long-lived AWS keys in GitHub.

### Later, for comparison only
The pilot (Phases 3–6) is a different shape:
- a 3-node Kubernetes cluster across AZs;
- Multi-AZ Postgres;
- managed Valkey;
- a 3-node Vault;
- CDN/WAF.

It is sized from pilot user numbers in its own spec.

## Monthly estimate (2026-10-05): partly verified, partly provisional
**Sources:**
- **Verified:** Cape Town EC2 on-demand prices, read from AWS's public price feed (the data behind the AWS calculator) on 2026-10-05.
- **Provisional:** everything else. These are us-east-1 list prices scaled by the Cape Town premium measured on EC2 (**1.30–1.32×** for `t3.large` and `m6i.large`). They must be confirmed in the AWS calculator before D1 is decided.
- **Basis:** USD, on-demand, 730 h/month, no commitments. Tax excluded.

### Verified EC2 prices, `af-south-1`, Linux on-demand
| Instance | vCPU / RAM | $/hour | $/month |
|---|---|---|---|
| `t3.micro` | 2 / 1 GiB | 0.0136 | 9.93 |
| `t3.small` | 2 / 2 GiB | 0.0271 | 19.78 |
| `t3.medium` | 2 / 4 GiB | 0.0542 | 39.57 |
| **`t3.large`** | 2 / 8 GiB | 0.1085 | **79.21** |
| `t4g.large` (Arm; needs arm64 images) | 2 / 8 GiB | 0.0867 | 63.29 |
| `m6i.large` (non-burstable) | 2 / 8 GiB | 0.1270 | 92.71 |
| `m6g.large` (Arm, non-burstable) | 2 / 8 GiB | 0.1016 | 74.17 |

### Recommended staging configuration
| Item | Choice | $/month | Basis |
|---|---|---|---|
| App VM | `t3.large`, 2 vCPU / 8 GiB | 79.21 | verified |
| Vault VM | `t3.small`, 2 vCPU / 2 GiB | 19.78 | verified |
| Managed PostgreSQL 18 | `db.t4g.medium`, Single-AZ, 2 vCPU / 4 GiB | ~62 | provisional |
| RDS storage | 20 GB gp3, 7-day PITR (backup storage up to the DB size is included) | ~3 | provisional |
| EBS (VM disks) | 40 + 20 GB gp3 | ~6 | provisional |
| Public IPv4 addresses | 2 (the app VM, plus Vault for KMS/S3 access without NAT) | ~7.30 | provisional |
| S3 | ~15 GB (uploads, locked backup bucket, Vault snapshots) | ~0.50 | provisional |
| ECR | ~10 GB of images | ~1.30 | provisional |
| KMS | 2 keys | ~2 | provisional |
| Secrets Manager | ~10 secrets | ~4 | provisional |
| CloudWatch Logs | ~10 GB ingested, 14-day retention | ~6 | provisional |
| Data out | < 50 GB (behind Cloudflare; within AWS's monthly free data-out allowance) | ~0 | provisional |
| Cloudflare (free plan), staging domain (~$10–15/year) | | ~1 | |
| **Total** | | **≈ $190/month** | 52% verified by value |

**Network choice built into this total:**
- No NAT gateway and no interface endpoints. Both VMs sit in public subnets with **no inbound access** except: 443 from Cloudflare to the app VM, and 8200 from the app VM's security group to Vault. RDS stays private.
- A NAT gateway would add roughly **$40–45/month**. Five interface endpoints would add a similar amount. Both are more than the two IPv4 addresses they replace.

### Alternatives
| Option | Change | ≈ $/month |
|---|---|---|
| **Lean** | `t4g.large` app VM (arm64 images), `t3.micro` Vault, `db.t4g.small` (2 GiB) Postgres | **≈ $135** |
| **Recommended** | As above | **≈ $190** |
| **Separated network** | Recommended, plus a NAT gateway with private subnets for both VMs | **≈ $235** |
| **Office hours only** | Recommended, with the VMs and RDS stopped outside ~12 h × 5 days (an instance scheduler). Breaks "deploy on every merge" outside those hours unless the pipeline starts staging first | **≈ $95** |

### Notes
- **Burstable `t3`:** a `t3` instance bills extra CPU credits if it runs above its baseline (30% for `t3.large`) for long periods. Staging is mostly idle. Watch the credit balance once ClamAV lands, and switch to `m6i.large` (+$13.50) if it runs hot.
- **No commitments:** 1-year Savings Plans or reserved instances cut ~30–40%. Revisit when staging's shape is stable.
- **Still to confirm in the AWS calculator:** every **provisional** line, the RDS instance class for PostgreSQL 18 in `af-south-1`, and the regional IPv4, NAT and endpoint rates. Then D1 (the ceiling) can be set against a fully verified number.

## Decisions needed from you

### D1 — Monthly budget ceiling for staging
This sets everything else. The cost drivers, from largest to smallest: managed Postgres, then the VM(s), then a managed Vault (if chosen), then backups and egress. Two tiers:
- **Lean:** one VM runs the app containers, Valkey and Vault, plus the smallest managed Postgres. This is the cheapest option that still meets SG1–SG8, though it puts the KEK on the app host.
- **Separated:** the same, but Vault runs on its own small VM, which keeps the KEK off the app host.

**Your input:** a monthly ceiling (₦ or $). The resource plan above is the bill of materials. The next step is a complete monthly estimate for it in `af-south-1` (Vault on its own VM, as integrated today), priced with the AWS calculator rather than from memory, with and without a NAT gateway.

### D2 — Provider and region
| Option | Pros | Cons |
|---|---|---|
| **AWS `af-south-1` (Cape Town)** | Matches [10 §2](../10-infrastructure-and-deployment.md)'s GA recommendation; mature managed Postgres, KMS (Vault auto-unseal) and Secrets Manager | Outside Nigeria. Staging holds only synthetic data, so no NDPA transfer question yet, but production will need one ([16 §7](../16-compliance-ndpa.md)) |
| Azure South Africa North / Google `africa-south1` (Johannesburg) | Similar managed services and latency | Different from the documented GA plan; more IaC to keep portable |
| Nigerian data centre or cloud (e.g. Rack Centre, MainOne/Equinix LG1) | In-country from day one | Less mature managed Postgres, KMS and secret managers, so we'd run more ourselves |

**Owner direction (2026-10-05):** AWS `af-south-1` is **tentative**. It is confirmed only once the resource plan below has a complete monthly estimate. Keep the IaC portable for in-country dedicated deployments.

### D3 — Database
- **Requirement:** PostgreSQL **18**, two databases (platform + `univarse_pool_01`), least-privilege roles created by our setup script, and the ability to `ALTER ROLE … SET` / pass `-c TimeZone=UTC` (already enforced per connection).
- **Option A (recommended):** the provider's managed Postgres. AWS lists PostgreSQL 18 for RDS in Cape Town. **Still to verify before anything else is proposed:**
  - the exact instance class we intend (resource plan below) is offered for PostgreSQL 18 in `af-south-1`;
  - Single-AZ, the gp3 storage type, point-in-time recovery and parameter groups (`rds.force_ssl`) work as needed;
  - our setup script's role and grant statements work without superuser (RDS has none).
- **Option B:** self-managed Postgres 18 on a VM. Only if Option A fails that check. We would then own backups, PITR and patching.

### D4 — Vault deployment ([ADR-023](../19-decision-log.md))
| Option | Unseal | Fits |
|---|---|---|
| **Single-node Vault (integrated Raft storage) on its own small VM, auto-unseal via cloud KMS** (recommended; **the estimate uses this**: Vault 2.1.1 Transit as integrated and tested today) | Automatic after a reboot | Keeps the KEK off the app host. Same model as production, minus HA |
| Single-node Vault as a container on the app VM, Shamir unseal | Manual after every reboot (a person must enter the unseal key) | Cheapest; the KEK shares the app host |
| HCP Vault (managed by HashiCorp) | Managed | Least operations work; highest cost; data handled by an additional sub-processor |
| OpenBao instead of Vault (same Transit API, open licence) | As above | Our documented exit from Vault's BSL licence. Choosing it now avoids a later migration |

### D5 — Domain and TLS
- **Domain:** a staging domain or subdomain you control, with wildcard tenant hosts (`*.staging.<domain>`).
- **DNS and certificates:** Cloudflare ([10 §3](../10-infrastructure-and-deployment.md)), with the origin locked to Cloudflare IPs and a Cloudflare origin certificate. Alternatively, Let's Encrypt via DNS-01.

### D6 — Who holds which credential
- **Cloud and IaC:** the cloud root account belongs to you; I use a least-privilege IaC role. Terraform state is encrypted, with state locking.
- **Vault:** the Vault root/recovery keys stay with you (and, later, split between two people). The key-admin token is held by an operator, never on the app VM.
- **Rule for me:** I won't handle any of these secrets directly (the same rule as the Postgres superuser password today). The pipeline and you hold them.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Kubernetes, multi-AZ high availability, read replica | Pilot (Phases 3–6, [10 §2](../10-infrastructure-and-deployment.md)) |
| Vault HA (3 nodes), DR replication | Before production |
| DAST and load tests against staging | After SG1–SG3 |
| NDPA transfer basis and DPAs | Before any real personal data ([16 §7](../16-compliance-ndpa.md)) |
