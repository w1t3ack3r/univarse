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

## Design for PR B (E7–E9), added 2026-10-05 before implementation
- **One sweep serves E7 and E9.** "Re-encrypt" means: bring every encrypted value of a tenant onto its **active** version. That covers values still on an older `v2` version (after a rotation) and `v1` values (the migration).
- **Encrypted-column registry:** `apps/api/src/shared/crypto/encrypted-columns.ts` lists every encrypted column with its row AAD:
  - `mfa_factor.secret_enc`, AAD `<tenant>:<user>:totp`;
  - `outbox_event.payload_enc`, AAD `<tenant>:outbox:<id>`. It is NULL after delivery, so only pending and dead events hold one.

  A test discovers every `*_enc` column in the tenant catalog and fails if one is missing from the registry, so a future encrypted field can't escape rotation or shredding.
- **Sweep requests** live in the platform table `key_reencryption`: one row per tenant, with `reason ROTATION | LEGACY_V1`, `requested_at`, `completed_at`, `rows_reencrypted` and `lease_until`.
  - Rotation and `migrate-v1` upsert a request.
  - A worker job (`KeyMaintenanceJob`, separate from the outbox loop, so a long sweep never delays email) claims one pending request under a lease, using `FOR UPDATE SKIP LOCKED`.
  - It re-encrypts in batches of 100 inside `ShardRegistry.tx`. Rows are locked with `SKIP LOCKED`, and each update is a compare-and-swap (`WHERE col = <old value>`), so it never overwrites a concurrent app write.
  - It reads the active version again for every batch. When a pass finds nothing left, it marks the request completed.
  - **Resumable without a cursor:** the work query *is* the cursor. A crash only loses the lease, which expires.
- **Rotation (E7):** `rotateTenantKey` works in two steps.
  1. It wraps a new DEK, outside any transaction.
  2. In one platform transaction it locks the ACTIVE row, marks it `RETIRED`, inserts version n+1 as `ACTIVE`, upserts a `ROTATION` sweep request, and writes the audit event `crypto.tenant_key.rotated` `{from, to}`.

  If two rotations run at once, one wins and the other fails cleanly: the row lock and the one-ACTIVE partial index both stop it. The keyring reads the active version for every write, so rotation needs no restart.
- **Destroying a retired version (E7)** is refused unless all three hold:
  1. the version is `RETIRED`;
  2. it was retired at least **1 hour** ago (default), which is longer than the keyring TTL and longer than any in-flight request that read the old active version;
  3. a usage scan across the registry finds **zero** values on that version.

  Then the wrap is erased in place and the audit event `crypto.tenant_key.destroyed` `{versions, reason}` is written.
- **KEK re-wrap (E8):**
  - An operator rotates the Vault key, which is a Vault admin action the app token can't perform (E3).
  - `rewrap-kek` then calls Transit `rewrap` for every live wrap made with an older Vault key version, updates each row by compare-and-swap, and writes one audit event `crypto.kek.rewrapped` `{kekId, keyVersion, count}`.
  - `rewrap` never shows the DEK to the caller. Transit keeps older key versions decryptable, so old wraps keep working until the re-wrap is done. Raising `min_decryption_version` afterwards is a separate operator step.
  - **Credential:** a separate Vault policy, `univarse-key-admin` (rewrap and read key metadata). Its token (`VAULT_ADMIN_TOKEN`) belongs to the operator CLI only and is never in the API or worker config. Dev and CI get one from `tools/vault-dev.mjs`.
- **v1 migration (E9):**
  - `migrate-v1` requests a `LEGACY_V1` sweep for every tenant, and the same worker sweep does the work.
  - `status` prints numbers only, per tenant: values per version, and values still `v1`.
  - When a tenant's sweep completes with no `v1` left, it writes the audit event `crypto.legacy_v1.migrated`.
  - **Contract-release condition:** `status` reports zero `v1` values for every tenant.
- **Operator entry point:** `pnpm --filter @univarse/api keys <status | rotate <slug> | migrate-v1 | destroy-retired <slug> <version> | rewrap-kek>`. It's a Nest application context like the worker, so shard access goes through `ShardRegistry` (invariant 1). The console replaces it in Phase 1.

## Implementation notes (PR A: E1–E6, E10–E12)
- **Package:** `@univarse/crypto` (`packages/crypto`). It holds the cipher, the providers, the keyring, `FieldCrypto`, key provisioning/destruction and the platform audit chain. The API registers one `FieldCrypto` provider (`apps/api/src/shared/crypto/envelope.ts`) for the HTTP app and the worker. `MfaService`, `Outbox` and `OutboxWorker` call only `FieldCrypto`.
- **Vault locally:** `pnpm dev:infra` starts `hashicorp/vault:2.1.1` (file storage, persistent volume, port bound to 127.0.0.1). It then runs `tools/vault-dev.mjs`, which:
  - initialises Vault once, keeping the unseal key and root token in the git-ignored `.vault-dev.json`, never in `.env` or output;
  - unseals it on every start;
  - ensures Transit, the derived KEK and the `univarse-app` policy (encrypt/decrypt on that key only);
  - keeps one periodic, least-privilege app token in `.env`.

  The script is idempotent: re-running it keeps the existing token. CI runs Vault in dev mode, and the same script configures it.
- **Provisioning:** `pnpm db:seed` now ends with `pnpm --filter @univarse/crypto run provision`, which gives every tenant an ACTIVE v1 key (idempotent). It prints versions and the KEK id only.
- **Transient Vault failures are retried once** (timeout, network error, 5xx; never a 4xx), then fail closed.
  - **Why:** found in E2E. A cold Transit call takes 200–400 ms on an idle dev machine, but under full E2E load it passed the 3 s timeout and failed a request.
  - **Safe:** encrypt/decrypt have no side effects.
  - **Errors:** `KeyUnavailableError.detail` (HTTP status or network error name) goes to server logs only. The client gets the generic `500 server.internal` problem (E6).
- **Platform audit chain (E12):** `platform_audit_event` gained `seq`. Each append takes a transaction-level advisory lock and hashes the canonical event with the previous hash. The app role can't UPDATE, DELETE or TRUNCATE it. `verifyPlatformAuditChain` checks the whole chain.
- **Shredding (E10)** erases in place: status `DESTROYED`, wrap set to NULL, `destroyed_at`. A check constraint refuses a `DESTROYED` row that still has a wrap, and the app role can't DELETE key rows.
- **v1 stays readable** with `DATA_ENCRYPTION_KEY` (now optional) until PR B migrates v1 values (E9). New writes are always v2.
- **Deviation (tracked):** the design note says the API role may only *read* `tenant_data_key`. In PR A, provisioning and shredding run as the same platform app role, which may INSERT and UPDATE (DELETE and TRUNCATE are revoked). A separate key-admin role, used by the console and scripts only, is listed below.
- **Known cost:** on a keyring cache miss, the Vault call happens inside the request's DB transaction (outbox enqueue, MFA enrol). That's at most one miss per tenant per hour per process; the retry bounds the worst case at about 6 s.
- **Tests:**
  - **Crypto unit (14):** the format, the providers, the keyring cache, `FieldCrypto` and the Vault retry, all against a fake Transit server.
  - **Crypto integration (10):** run against real Vault, tagged E1, E2, E3, E6, E10, E11 and E12.
  - **API:** the MFA test now proves the stored secret is `v2` under the tenant's own key and fails under the other tenant's.
  - **Mutations caught:**
    - the wrap context without the tenant ([E2]);
    - shredding without erasing the wrap (6 tests, and the DB check constraint);
    - the cross-tenant MFA assertion pointed at the same tenant;
    - no retry;
    - retrying 4xx.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Blind indexes for searchable encrypted fields (NIN) | The first searchable encrypted field (admissions/records) |
| Two-person approval for crypto-shredding | Phase 1 console (offboarding workflow) |
| Vault HA (3-node Raft), auto-unseal, snapshots, audit device | Before production (staging can run single-node) |
| Per-tenant KEKs (dedicated tier) | Dedicated-deployment work |
| Separate key-admin DB role: the API role only reads `tenant_data_key` | Phase 1 console (tenant provisioning and offboarding) |
| DEK rotation, KEK re-wrap, v1 → v2 migration (E7–E9) | PR B of this spec |
| Remove the v1 key and code path | The release after E9 reports zero v1 values |
