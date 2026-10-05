# Spec 0006 — Envelope encryption: per-tenant data keys wrapped by a key-encryption key

**Status:** Accepted (2026-10-05). D1 decided: HashiCorp Vault Transit ([ADR-023](../19-decision-log.md)) · **Phase:** 0 (hard gate before staging) · Closes the [ADR-018](../19-decision-log.md) deviation and implements [07 §8](../07-data-and-database.md).
Every AC ID appears in at least one test name.

**Delivery:**
- **PR A:** the envelope itself (E1–E6, E10–E12). It adds `tenant_data_key`, the `vault` and `local` providers, the keyring cache, `v2` writes for MFA secrets and outbox payloads, provisioning, crypto-shredding and platform audit. Vault runs in dev compose and CI.
- **PR B:** rotation and migration (E7–E9). Tenant DEK rotation with re-encryption, KEK re-wrap, and the v1 → v2 migration with its zero-v1 check.
- **The contract step** (removing the v1 key and code path) ships in a later release, per invariant 9. ADR-018 closes when staging runs the `vault` provider.

## Why
Today every encrypted field (TOTP secrets, outbox email payloads) uses **one platform-wide key** (ADR-018).
- A leak of that key exposes every institution.
- Rotating it means re-encrypting everything.
- Deleting one institution's data cryptographically ("crypto-shredding" on offboarding, docs/16) is impossible.

Envelope encryption fixes all three:
- Each tenant gets its own **data encryption key (DEK)**.
- DEKs are stored only **wrapped** (encrypted) by a **key-encryption key (KEK)** that never leaves the key service.
- Data is encrypted with the tenant's DEK.

## Terms
| Term | Meaning |
|---|---|
| **DEK** | A random 256-bit AES key belonging to one tenant. Encrypts that tenant's fields. Never stored in plaintext. |
| **KEK** | The key that wraps DEKs. Lives in a key service (KMS, or for local/CI a secret). Never in a database. |
| **Wrapped DEK** | A DEK encrypted under the KEK, stored in the platform DB. Useless without the KEK. |
| **Key version** | Each tenant can have several DEKs over time (rotation); new writes use the active one. |
| **Crypto-shredding** | Destroying a tenant's wrapped DEKs, so all its encrypted fields become permanently unreadable. |

## Acceptance criteria

| ID | Acceptance criterion |
|----|----------------------|
| E1 | *Per-tenant DEKs.* Each tenant has its own DEK. Two tenants never share key material. A value encrypted for tenant A can't be decrypted with tenant B's key, even if its AAD is rewritten. |
| E2 | *Wrapped at rest, apart from the data.* DEKs are stored only wrapped by the KEK, in the **platform DB** (`tenant_data_key`), never in a tenant shard. A dump of a shard alone, or of the platform DB alone, reveals no plaintext field. The wrap is bound to its tenant and version (AAD), so a wrapped DEK copied to another tenant's row won't unwrap. |
| E3 | *Key service boundary.* All wrap and unwrap calls go through one `KeyService` port with providers (D1). The KEK and plaintext DEKs never appear in logs, errors, API responses, audit records or DB rows. |
| E4 | *v2 format.* New ciphertexts are `v2:<keyVersion>:<iv>:<ciphertext>:<tag>` (AES-256-GCM, random 96-bit IV). The tenant is implied by context and bound by AAD, which keeps its current shape (`<tenantId>:…:<purpose>`). Every new write uses the tenant's **active** version. |
| E5 | *Cache with a bound.* Unwrapped DEKs are cached in memory for at most **1 hour** (docs/07 §8), within a size cap. Evicted keys are zeroed. A KEK provider outage doesn't break tenants whose DEK is cached. |
| E6 | *Fail closed.* If a tenant's DEK can't be unwrapped (provider down, key destroyed), operations that need it fail with a generic error (`server.not_ready` or a 5xx problem). They **never** fall back to the old v1 key for new writes, and never store plaintext. |
| E7 | *DEK rotation.* Rotating creates a new active version and leaves the old one able to decrypt (status `RETIRED`). A re-encryption job moves the tenant's values to the active version. Only then can an old version be destroyed. Rotation is per tenant and audited. |
| E8 | *KEK rotation.* Rotating the KEK re-wraps every DEK under the new KEK without touching tenant data. Old wraps stay usable until re-wrapping completes. |
| E9 | *v1 migration (expand → migrate → contract, invariant 9).* Reads accept `v1` (old single key) and `v2`. A migration job re-encrypts every `v1` value (MFA secrets, any pending outbox payloads) to `v2`, idempotently and resumably. Once a check reports zero `v1` values, a **later release** removes the v1 key and code path. |
| E10 | *Crypto-shredding.* Destroying a tenant's DEKs (status `DESTROYED`, wrapped bytes erased) makes every encrypted field of that tenant permanently undecryptable, and **only** that tenant's. Proven by a test across two tenants. The operation is platform-only (never a tenant endpoint) and audited. |
| E11 | *Provisioning.* A tenant's first DEK is created when it is provisioned (seed, and later the console). Using encryption for a tenant without an active DEK is a programming error caught by tests, not a silent fallback. |
| E12 | *Audit.* Create, rotate, KEK re-wrap, destroy and the v1 migration's completion write platform audit events (actor, tenant, key version; never key material), in the hash-chained platform audit log. |

## Design notes
- **Storage:** `tenant_data_key(id, tenant_id, version, status ACTIVE|RETIRED|DESTROYED, kek_id, wrapped_dek bytea NULL after destroy, created_at, retired_at, destroyed_at)` in the platform DB. Unique `(tenant_id, version)`, and at most one `ACTIVE` per tenant (partial unique index).
  - The API role may only **read** it.
  - Writes happen through the platform key service (seed / scripts now, the console later).
- **Wrap AAD:** `univarse:dek:<tenantId>:<version>`, so a wrapped DEK can't be moved between tenants or versions (E2).
- **Data AAD** stays as today, e.g. `<tenantId>:<userId>:totp` and `<tenantId>:outbox:<eventId>`. With per-tenant DEKs, a cross-tenant copy now fails on two counts: wrong key and wrong AAD.
- **One call site:** `FieldCrypto.encrypt(tenantId, plaintext, aad)` / `decrypt(tenantId, stored, aad)` replaces direct `encryptField` use in `MfaService`, `Outbox` and `OutboxWorker`. Callers never see keys.
- **Jobs:** the re-encryption job (E7, E9) runs in the worker, tenant by tenant under RLS, in small batches, recording progress. It never holds every DEK at once.
- **Providers:**
  - `vault`: Transit, used locally, in CI and in deployed environments. Local and CI run a Vault dev server.
  - `local`: an in-process KEK for unit tests only, refused at boot when `NODE_ENV=production`.

## Decision D1 — where the KEK lives (decided 2026-10-05: **B, HashiCorp Vault Transit**, [ADR-023](../19-decision-log.md))
The code is provider-agnostic (E3). The options considered:

| Option | What it means | Fits |
|---|---|---|
| **A. Cloud KMS** (AWS KMS in `af-south-1`, matching docs/10 Option A) | The KEK never leaves the KMS; unwrap is an IAM-authorised API call; key-use is logged by the provider | The recommended GA region, strongest separation, small per-call cost (mitigated by the 1 h cache) |
| **B. HashiCorp Vault Transit** (self-hosted) | Same model, on infrastructure we run; cloud-portable, works for in-country dedicated deployments | Higher ops burden in Phase 0 |
| **C. Secret-manager KEK** (the `local` provider with the KEK in the secret manager) | Real envelope separation (per-tenant DEKs, crypto-shredding, rotation) but the KEK sits in process memory | Acceptable only as a recorded, time-boxed staging step; not for production |

**Chosen: B.** The user chose self-hosted Vault Transit over AWS KMS. It keeps keys on infrastructure UniVarse runs, and the same setup serves an in-country dedicated deployment. How it works:
- The KEK is a `derived` `aes256-gcm96` Transit key; the wrap context is `univarse:dek:<tenantId>:<version>`.
- The app policy allows only encrypt and decrypt.
- It's built on the Transit API that OpenBao also implements (Vault is BSL-licensed; OpenBao is the MPL fork and our exit).
- Local and CI run a Vault dev server.
- **ADR-018 closes when staging runs the `vault` provider.**

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Blind indexes for searchable encrypted fields (NIN) | The first searchable encrypted field (admissions/records) |
| Two-person approval for crypto-shredding | Phase 1 console (offboarding workflow) |
| Vault HA (3-node Raft), auto-unseal, snapshots, audit device | Before production (staging can run single-node) |
| Per-tenant KEKs (dedicated tier) | Dedicated-deployment work |
