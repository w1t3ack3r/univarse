# Spec 0008 — Staging environment (planning; decisions needed before build)

**Status:** Draft for decision (2026-10-05). D1–D6 open, and **only the owner can decide them** · **Phase:** 0 exit gate · Builds on [10 §1–2, §7](../10-infrastructure-and-deployment.md), [09 §3–5](../09-container-security.md) and [ADR-023](../19-decision-log.md).

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

## Decisions needed from you

### D1 — Monthly budget ceiling for staging
This sets everything else. The cost drivers, from largest to smallest: managed Postgres, then the VM(s), then a managed Vault (if chosen), then backups and egress. Two tiers:
- **Lean:** one VM runs the app containers, Valkey and Vault, plus the smallest managed Postgres. This is the cheapest option that still meets SG1–SG8, though it puts the KEK on the app host.
- **Separated:** the same, but Vault runs on its own small VM, which keeps the KEK off the app host.

**Your input:** a monthly ceiling (₦ or $). I'll then price both tiers with the provider's calculator for D2's choice. Prices change, so I won't quote figures from memory.

### D2 — Provider and region
| Option | Pros | Cons |
|---|---|---|
| **AWS `af-south-1` (Cape Town)** | Matches [10 §2](../10-infrastructure-and-deployment.md)'s GA recommendation; mature managed Postgres, KMS (Vault auto-unseal) and Secrets Manager | Outside Nigeria. Staging holds only synthetic data, so no NDPA transfer question yet, but production will need one ([16 §7](../16-compliance-ndpa.md)) |
| Azure South Africa North / Google `africa-south1` (Johannesburg) | Similar managed services and latency | Different from the documented GA plan; more IaC to keep portable |
| Nigerian data centre or cloud (e.g. Rack Centre, MainOne/Equinix LG1) | In-country from day one | Less mature managed Postgres, KMS and secret managers, so we'd run more ourselves |

**Recommendation:** AWS `af-south-1`, so staging rehearses the production plan. Keep the IaC portable for in-country dedicated deployments.

### D3 — Database
- **Requirement:** PostgreSQL **18**, two databases (platform + `univarse_pool_01`), least-privilege roles created by our setup script, and the ability to `ALTER ROLE … SET` / pass `-c TimeZone=UTC` (already enforced per connection).
- **Option A (recommended):** the provider's managed Postgres, **if it offers version 18 in the chosen region**. I'll verify that before you commit.
- **Option B:** self-managed Postgres 18 on the VM, with WAL archiving to object storage. Cheaper, but we then own backups and patching.

### D4 — Vault deployment ([ADR-023](../19-decision-log.md))
| Option | Unseal | Fits |
|---|---|---|
| **Single-node Vault (integrated Raft storage) on its own small VM, auto-unseal via cloud KMS** (recommended) | Automatic after a reboot | Keeps the KEK off the app host. Same model as production, minus HA |
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
