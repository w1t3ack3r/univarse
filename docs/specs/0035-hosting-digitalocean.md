# Spec 0035: Hosting on DigitalOcean, staging first

**Status:** Draft for the owner's approval (2026-11-12): H1 to H12. Nothing is created on DigitalOcean until it's approved.
**Phase:** between Phase 1 and pilot readiness. Amends [ADR-030](../19-decision-log.md) (fully local) and supersedes [spec 0008](0008-staging-environment.md) (AWS staging, paused), with a new ADR (H1).
**Builds on:**

- [ADR-030](../19-decision-log.md): everything local, nothing hosted; the local production-like stack ([spec 0019](0019-local-production-stack.md)) is the release gate;
- [spec 0013](0013-container-images-scan-sign.md) (images built, scanned, signed and verified offline) and [spec 0020](0020-local-backups-and-shred-ledger.md) (sealed backups, the shred ledger and its object lock);
- [ADR-023](../19-decision-log.md) (Vault, not a cloud KMS), [ADR-036](../19-decision-log.md) (BullMQ, Valkey `noeviction`);
- [10](../10-infrastructure-and-deployment.md) (environments, the target shape), [16](../16-compliance-ndpa.md) (the NDPA), [spec 0036](0036-hybrid-tenancy.md) (where institutions' data lives);
- the owner's choice of DigitalOcean (2026-11-12), after the provider research in this session.

## Why

UniVarse has been built, released and deployed entirely on the owner's machine (ADR-030). Before a pilot institution can use it, it has to run somewhere reachable, under the same discipline: verified images, sealed backups, Vault, nothing secret in a provider's console. Staging comes first: it proves the stack runs outside this machine, with made-up data only, before any real person's data is involved.

## What DigitalOcean offers (checked 2026-11-12)

- **Regions:** 20 datacenters in 13 regions; **none in Africa**. The nearest to Nigeria are London (`lon1`), Amsterdam (`ams3`) and Frankfurt (`fra1`). Managed databases and Kubernetes are in every region; Spaces in most.
- **Managed PostgreSQL:** versions 15 to **18** (18 the default for new clusters). **No superuser**: the admin user (`doadmin`) is not one. Backend connections by size: 1 GiB 22, 2 GiB 47, 4 GiB 97, 8 GiB 197, 16 GiB 397. Its built-in PgBouncer allows **21 pools per cluster**. Prices (single node, basic): 1 GiB $15.15, 2 GiB $30.45, 4 GiB $60.90, 8 GiB $122.10 a month; a standby node is extra (price not shown on the page) `[VERIFY]`.
- **Droplets:** Basic 8 GiB / 4 vCPU / 160 GiB at $48 a month; 16 GiB / 8 vCPU / 320 GiB at $96.
- **Kubernetes:** from $12 a month, with a free control plane (HA control plane price `[VERIFY]`). **Load balancer:** from $12. **Managed Valkey:** from $15. **Container Registry:** a free tier (1 repository, 500 MiB); paid tiers `[VERIFY]`.
- **Spaces** (S3-compatible): from $5 a month. **Object lock appears unsupported** (a DigitalOcean community answer; `[VERIFY]` against the current S3 compatibility list). Spec 0020's backup bucket and shred ledger depend on a COMPLIANCE object lock.

## Decisions for approval

| # | Decision | Why |
| --- | --- | --- |
| H1 | **A new ADR (ADR-037) amends ADR-030:** UniVarse may be hosted on DigitalOcean. The local production-like stack stays the release gate: every image is released, scanned, signed and verified on the owner's machine first, exactly as now, and a host only ever runs verified images by digest. | ADR-030 was the owner's decision; this changes it, so it's recorded the same way. Nothing about how a release is proved changes. |
| H2 | **Region: London (`lon1`),** chosen by measurement: before anything is created, the owner measures latency from Lagos (and from a pilot institution's network if possible) to `lon1`, `ams3` and `fra1`, and the lowest wins. | No region in Africa; the subsea routes from Lagos land in Europe. A measurement beats a guess. |
| H3 | **Staging first, as one Droplet running the stack exactly as it runs here** (the hardened compose of spec 0019, the verified images, Caddy, Vault, PostgreSQL, PgBouncer, Valkey, SeaweedFS, ClamAV): Basic 16 GiB / 8 vCPU ($96 a month). **Made-up data only:** the seed's institutions and ones provisioned on staging, never a real person's details. | The smallest change from what's already proven; 8 GiB is already tight here (memory starvation stalled releases on this machine), so staging gets double. |
| H4 | **Staging is reachable by staff only:** Cloudflare in front (DNS, TLS, WAF) with Cloudflare Access on every staging host, the Droplet's firewall open only to Cloudflare's ranges and to SSH from the owner's address, SSH by key only, no password login. The console keeps its own allowlist (spec 0027). | A staging site on the internet is still an attack surface, and it has the same code as production. |
| H5 | **Images reach the Droplet from DigitalOcean's Container Registry (private),** pushed by digest from the owner's machine after the release; the Droplet pulls by digest and verifies the signatures against the committed public key before running anything (`images:verify`, as the deploy does now). The signing key never leaves the owner's machine. | ADR-029/ADR-030 kept registries local; a private registry is the least change that lets a remote host pull, and verification stays where it is. |
| H6 | **No secret in DigitalOcean's console, metadata or user-data.** The stack's secrets are generated on the Droplet by `stack:init` (as here), Vault is initialised there, and its unseal key goes to the owner (as `vault-init.json` does now), never to a provider's secret store. | Invariant 8, and ADR-023: keys under our control, not a provider's. |
| H7 | **Backups leave DigitalOcean:** the sealed backup sets and the shred ledger go to an S3 store **with object lock in COMPLIANCE mode, at another provider** (`[VERIFY]` candidates: Backblaze B2, Wasabi, or AWS S3), plus a copy on the owner's machine. Spaces is used only for uploaded files. | Spec 0020 depends on an object lock Spaces lacks; and an off-site copy at a different provider survives the loss of the DigitalOcean account. |
| H8 | **Production is a later, separate spec,** written when the first institution is close. Its expected shape: Kubernetes (DOKS, three nodes), managed PostgreSQL 18 with a standby (the platform database and the pool shards), our own PgBouncer in the cluster, Valkey, Vault on Raft (three nodes), Cloudflare in front, backups as H7. Estimated at roughly $400 to $700 a month at pilot size `[VERIFY]` when written. | Staging should teach us DigitalOcean before production is designed in detail. |
| H9 | **Managed PostgreSQL has no superuser, so the bootstrap changes for it:** the migrate job's bootstrap runs as `doadmin` to create the roles, grants and RLS (the roles need no superuser attribute; the tests already require that). Proved on staging in a step of its own (H11) before production depends on it. | Our bootstrap was written against a superuser; whether `doadmin` can create roles with the exact grants, and own the `SECURITY DEFINER` capture functions, is `[VERIFY]`, and only a real cluster answers it. |
| H10 | **No real personal data on DigitalOcean until the NDPA's cross-border rules are met:** a data protection impact assessment, an NDPC-approved transfer instrument (in practice, a signed data processing agreement with standard clauses), DigitalOcean listed as a sub-processor, and counsel's sign-off. Staging never needs it (made-up data). | Hosting in London is a cross-border transfer, which the GAID treats as high-risk. |
| H11 | **Staging in three steps, each signed off by the owner:**<br>S-1: the Droplet, the stack and Cloudflare; the release deployed by digest; the smoke check passes remotely.<br>S-2: backups to the off-site object-locked store; a restore rehearsal from it.<br>S-3: PostgreSQL moved to managed PostgreSQL 18 (H9), PgBouncer and RLS checks passing against it. | Each step is small and reversible, and the first two change nothing about the database. |
| H12 | **Cost and teardown:** a monthly budget alert on the account; staging can be destroyed and rebuilt from the release and the backups (`stack:init`, `stack:deploy`, a restore), which S-2 proves. | Staging shouldn't become a pet. |

## Acceptance criteria

1. ADR-037 is recorded and ADR-030 marked as amended; spec 0008 marked superseded.
2. The latency measurement is recorded, and the region chosen from it (H2).
3. Staging runs the release's verified images by digest; the deploy refuses an unsigned or mismatched image there, as it does locally.
4. Every staging host is behind Cloudflare Access; the Droplet answers nothing but Cloudflare's ranges on 443 and the owner's address on SSH (a scan from outside proves it).
5. No secret exists in DigitalOcean's console, metadata or user-data (checked by reading each).
6. The stack's smoke check passes on staging, its Vault and token checks included.
7. A backup set reaches the off-site object-locked store, can't be deleted before its retention, and restores into a fresh stack (S-2).
8. On managed PostgreSQL 18: the bootstrap, the migrations, `rls:check` and the integration suite pass (S-3), or this spec records why not and what replaces it.
9. Only made-up data on staging, ever; the seed and provisioning are the only sources.

## The owner's steps

- Approve or change H1 to H12.
- Create the DigitalOcean account (and the off-site storage account, H7), with two-factor sign-in; add a budget alert. I don't create accounts or enter payment details.
- Measure latency from Lagos to the three candidate regions (I'll give the commands).
- Cloudflare: the domain, and Access for staff.
- Counsel, for production only (H10).

## Affected docs

In the implementation PRs: [10](../10-infrastructure-and-deployment.md) (environments, staging), [09](../09-container-security.md) (the host's hardening), [16](../16-compliance-ndpa.md) (sub-processors), [19](../19-decision-log.md) (ADR-037), [18](../18-roadmap.md), [spec 0008](0008-staging-environment.md) (superseded).

## Out of scope

Production (H8's own spec), custom domains for institutions (spec 0025 A10, once there's public DNS: it becomes possible here), dedicated databases and clusters (spec 0036), a CDN for uploads.
