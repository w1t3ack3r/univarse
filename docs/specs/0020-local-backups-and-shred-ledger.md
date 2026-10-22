# Spec 0020: Local backups with a rehearsed restore, and the shred ledger

**Status:** **Draft, revision 1 (2026-10-22)**, for the owner's review. Nothing is built yet.
**Phase:** 0. Roadmap item **7.5** under [ADR-030](../19-decision-log.md): local backups with a rehearsed restore, and the shred ledger. It is the last local-stack requirement before Phase 0 can close.
**Builds on:**

- [spec 0019](0019-local-production-stack.md): the stack, its verified deploy, the stack CA, Vault on TLS with its audit device, SeaweedFS behind Caddy, the owner-only `~/.univarse/stack`;
- [spec 0006](0006-envelope-encryption.md): per-tenant DEKs wrapped by Vault Transit, crypto-shredding (E10), the destruction boundary and its restore rule;
- [spec 0002](0002-audit-and-outbox.md): the hash-chained audit logs (A5), whose external anchoring is due before GA;
- [10 §7](../10-infrastructure-and-deployment.md): production's backup design (PITR, snapshots, drills), which this spec rehearses locally;
- [16 §5](../16-compliance-ndpa.md): backup retention as the erasure boundary.

## Why

The stack holds data that matters only if it can be got back: two PostgreSQL databases, Vault's Transit key (without it, every wrapped DEK, and so every encrypted field, is unreadable), the files in SeaweedFS, and the secrets in `~/.univarse/stack`. Today none of it is backed up, and no restore has ever been tried. A backup that has never been restored isn't a backup.

Restoring brings a second problem, which spec 0006 named but left unbuilt. A tenant's keys can be **destroyed** (crypto-shredding, E10). A backup taken before that holds the wrapped keys, and the shared KEK still unwraps them. So restoring it would quietly bring the tenant's data back. Spec 0006 requires that "after any platform-DB restore, every destruction recorded after the restore point must be re-applied before the API and worker start", and that destructions be recorded in a **ledger outside the platform DB**, because a restore rolls the platform DB, and its audit chain, back too.

## Decisions

| #   | Decision | Recommendation |
| --- | -------- | -------------- |
| D1  | **Two PRs, the ledger first.** **A:** the shred ledger, its reconciliation and its re-apply step in every deploy. **B:** backups, the restore, and the rehearsal, with a shred drill. | **As written.** No restore may exist before the ledger that makes restoring safe. Ledger first also protects the stack at once: any deploy re-applies destructions. |
| D2  | **What a backup holds.** A *backup set* is: PostgreSQL (both databases, physically, D3); Vault's storage (a Raft snapshot, D4); SeaweedFS's **clean** bucket (quarantine is transient and is rescanned); and the parts of `~/.univarse/stack` a restore needs (`secrets.json`, `vault-init.json`, the internal `certs/`, the edge CA in `edge/`). Plus a manifest. **Not** backed up: Valkey (not a system of record, docs/10 §7), ClamAV's database, Caddy's data, rendered files (the deploy re-renders them), the local registry (releases are rebuilt and re-signed, and the record names their digests). | **As written.** The minimum that rebuilds the running stack exactly, with nothing re-creatable. |
| D3  | **PostgreSQL: physical base backups plus continuous WAL archiving**, so a restore can reach any point in time (PITR) since the oldest base backup kept. `archive_mode = on`, `archive_command` writing each WAL segment to the backup destination's WAL area; `pg_basebackup` for each set. | **(a) PITR, as production.** docs/10 §7 is PITR with a 15-minute RPO; rehearsing the same mechanism locally is the point. A nightly `pg_dump` (b) is simpler but gives a 24-hour RPO and a different restore path than production's. |
| D4  | **Vault moves to integrated (Raft) storage, single node**, so `vault operator raft snapshot save` takes a consistent copy while Vault runs. The existing file storage is migrated once (`vault operator migrate`, offline, Vault stopped), with a backup of the old volume kept until the migrated Vault is verified. | **As written.** The file backend can't be copied consistently while running, and sealing Vault for every backup would need the owner's unseal each time. Production is Raft (docs/10 §3). |
| D5  | **Every backup set is sealed to the owner's backup public key.** Each artifact is encrypted with a fresh random key (AES-256-GCM, streamed in authenticated chunks, numbered and with a final-chunk flag, so truncation and reordering fail), and that key is wrapped to an **X25519 public key** (ECDH, HKDF-SHA-256). The public key sits in the repository, the **private key only with the owner, offline**, like the signing key: `pnpm stack:backup keygen` writes it to a path the owner chooses, once, and never into `~/.univarse/stack`. A restore asks for its path. Built on Node's `crypto`, no new tool. | **As written.** Backups hold every secret the stack has; if they were encrypted with a key kept beside them, anyone who could read the backups could read the secrets. Sealing to an offline key means a stolen backup, or a stolen `~/.univarse/stack`, reveals nothing. The cost is the owner's step at every restore, which is the right place for it. |
| D6  | **Where backups go: `~/.univarse/backups/` by default, owner-only, or a path the owner sets** (an external drive). Retention: the 7 newest daily sets and the 4 newest weekly ones, with the WAL kept back to the oldest set kept; the older ones are deleted by `stack:backup prune`. Backups are taken on demand (`pnpm stack:backup`); a schedule (Windows Task Scheduler) is the owner's choice, documented. | **As written.** **Stated limit:** a backup on the same disk survives a broken stack, a bad migration or an operator mistake, but not the loss of the disk or the machine. Only the owner's copy on separate media does. So retention, the erasure boundary (D8), is about 35 days locally. |
| D7  | **The shred ledger.** Every key destruction (offboarding's `destroyTenantKeys`, and `destroy-retired`) is recorded **outside the platform DB**, in an append-only bucket (`uv-shred-ledger`) in the stack's SeaweedFS with **Object Lock in COMPLIANCE mode** (verified on SeaweedFS 4.48: a locked entry can't be deleted). The API and worker write it through their own S3 identity, allowed only to write and read that bucket. Entries are hash-chained JSON (`seq`, `prev`, tenant, versions, `destroyed_at`, the platform audit event's id; never key material). **Order:** the destruction commits first, then the ledger is appended; a failed append makes the command fail loudly, and a **reconciliation** in the worker (every 5 minutes) appends any `DESTROYED` key the ledger lacks. A **mirror** of the ledger, at the backup destination, is refreshed by the host-side commands (every deploy and every backup), since no container can reach it. | **As written.** Appending first would re-apply a destruction whose own transaction rolled back. Appending after, with reconciliation, leaves only a short window, bounded by the interval, in which a destruction exists only in the live DB, and it is stated. The mirror survives the loss of the stack's volumes; the ledger in each backup set (D2) survives the loss of the disk, on the owner's separate media. **Stated limit:** on one machine, Object Lock stops the app, an accident or a script, not someone with root on the Docker VM; the hash chain then makes an edit visible, not impossible. |
| D8  | **Re-applying destructions.** A new deploy step, after the migrate job and before the API and worker start, reads the bucket and the mirror, verifies their chains, takes their union, and makes sure every listed key is `DESTROYED` with its wrap erased. A restore (D9) does the same with every ledger it can read, the backup sets' included, since it holds the owner's private key. The step is idempotent, audited, and **fails the deploy** if no copy of the ledger is readable. Because every deploy runs it, a restore followed by a deploy can never start the app with a destroyed tenant's keys back. | **As written.** This is spec 0006's restore rule, enforced where nothing can skip it. It makes erasure **safe in operation**, not **complete**: the backups taken before the destruction still hold the wrapped keys until they expire (spec 0006's wording, kept). |
| D9  | **The restore is a rehearsal first, into an isolated stack.** `pnpm stack:restore-rehearsal <set> [--to <time>]` restores into a separate compose project (`univarse-restore`), on internal networks only, with no published port and no edge: PostgreSQL, Vault and SeaweedFS only. It never touches the running stack. A restore **over** the running stack (`pnpm stack:restore`) is the same steps against the stack itself, after `stack:down`, and is documented, not rehearsed against live data by default. | **As written.** A rehearsal that could damage the stack would never be run. The isolated stack is small enough for this machine with the main stack stopped. |
| D10 | **What the rehearsal must prove,** recorded as a drill in `docs/ops/drills/`: every artifact decrypts and matches the manifest; PostgreSQL reaches the requested point in time; `rls:check` passes; every tenant's and the platform's audit chains verify; row counts match the manifest's; every active tenant DEK unwraps through the restored Vault; every restored file's SHA-256 matches; **the shred drill** (D11) holds; and the timings (RTO, and the RPO reached). | **As written.** The same checks as production's quarterly drill (docs/10 §7), locally. |
| D11 | **The shred drill.** In the rehearsal, a drill tenant (`shred-drill`, created for it) has its keys destroyed **after** the backup was taken. Restoring that backup brings its wrapped keys back; the re-apply step must then leave it undecryptable while every other tenant still decrypts. The opposite control: without the re-apply step, the drill tenant's data decrypts (shown, then removed). | **As written.** It proves the property the ledger exists for, end to end, against the real restore. |
| D12 | **Anchoring the audit chains.** Each backup set's manifest records the head (`seq`, hash) of the platform audit chain and of each tenant's, and the ledger records the same at each destruction. A restore's verification compares the restored chains against them. | **As written.** It is the external anchor spec 0002 asks for before GA, at no extra cost, and it shows a restore didn't splice in a rewritten chain. |

## Acceptance criteria

| ID   | Criterion |
| ---- | --------- |
| BK1  | _The ledger (PR A)._ Destroying a tenant's keys appends one entry to the object-locked bucket and to the mirror, hash-chained, holding no key material. A test shows: a destruction that rolls back appends nothing; a failed append fails the command; the reconciliation appends a `DESTROYED` key the ledger lacks, once; an edited or deleted entry breaks the chain's verification; deleting a locked entry through S3 is refused. |
| BK2  | _Re-apply at deploy (PR A)._ The deploy runs the re-apply step after the migrate job and before the app. A test with a platform DB whose destroyed keys are back (as a restore would leave it) shows the step destroys them again, audits it, and the API then starts. With no readable ledger copy, the deploy stops before the app starts. The step changes nothing when nothing is to be re-applied. |
| BK3  | _A backup set (PR B)._ `pnpm stack:backup` writes a set with the manifest (versions, sizes, SHA-256 of every artifact, the audit chain heads, the ledger head, the deployed digests), each artifact sealed to the backup public key (D5). A test shows a set's artifacts don't decrypt without the private key, a truncated or reordered artifact fails to decrypt, and no secret value appears in clear in the set or in the command's output. |
| BK4  | _PITR (PR B)._ WAL is archived continuously; a restore to a time between two base backups reaches it (a row written before it is present, one written after is absent). |
| BK5  | _Vault (PR B)._ Vault runs on Raft; the one-time migration from file storage keeps the Transit key (every existing wrapped DEK still unwraps afterwards); a snapshot restored into the isolated stack unwraps every active DEK. |
| BK6  | _The rehearsal (PR B)._ `pnpm stack:restore-rehearsal` proves every D10 check against a real set, leaves the running stack untouched, and records a drill with its timings. It removes the isolated stack afterwards, even when a check fails. |
| BK7  | _The shred drill (PR B)._ D11, both halves: with the re-apply step the drill tenant is undecryptable and every other tenant decrypts; without it, the drill tenant decrypts (the control). |
| BK8  | _Retention (PR B)._ `stack:backup prune` keeps the 7 newest daily and 4 newest weekly sets and the WAL they need, and deletes the rest; it never deletes the newest set, nor any WAL a kept set needs. |
| BK9  | _Secrets (both)._ The backup private key is never written into `~/.univarse/stack` or the repository; no command prints a secret; a scan of the repository and every command's output finds none of the stack's generated values (spec 0019 LS9's scan). |
| BK10 | _Evidence._ Every BK ID appears in a test or a recorded check. Mutations, each failing its check: the ledger appended before the commit (BK1); the reconciliation skipped (BK1); the re-apply step after the app starts, or skipped (BK2); a set artifact without chunk authentication (BK3); the private key written beside the backups (BK9); the shred drill without the re-apply step passing (BK7); prune deleting the newest set (BK8). |

## Design

**Files.**

- `tools/stack/src/ledger.ts`: append, verify, union and reconcile; the bucket and the mirror.
- `tools/stack/src/reapply.ts`: the deploy step (D8).
- `tools/stack/src/backup.ts`: `pnpm stack:backup [keygen | prune]`.
- `tools/stack/src/seal.ts`: D5's streamed sealing and unsealing.
- `tools/stack/src/restore.ts`: `pnpm stack:restore-rehearsal` and `pnpm stack:restore`.
- `infra/stack/compose.yml`: PostgreSQL's WAL archiving, Vault on Raft.
- `infra/stack/restore.compose.yml`: the isolated rehearsal stack.
- `infra/backup/backup.pub`: the owner's backup public key, committed after `keygen`.
- `docs/ops/drills/`: the drill records.

**The order of a backup.** Take the lock (the same registry lock a deploy and a prune use, so a backup never races a deploy) → write the manifest's header → `pg_basebackup` → the Vault Raft snapshot → the clean bucket's objects → the stack directory's parts → the ledger copy and the audit chain heads → seal each artifact as it is written → write the manifest last, and sealed → release the lock. A set without its manifest is incomplete and ignored.

**The order of a restore.** Unseal the set with the owner's private key → verify the manifest and every artifact's hash → restore PostgreSQL to the point → restore Vault's snapshot and unseal it with the restored `vault-init.json` → restore the files → run the migrate job's checks (`rls:check`) → **re-apply the ledger (D8)** → only then, for a real restore, deploy the release named in the set's manifest.

**Where the destructions come from.** `destroyTenantKeys` (offboarding, spec 0006 E10) and `destroyRetiredKey` (E7) in `@univarse/crypto` both end with the ledger append. The ledger is the stack's, so the append goes through a small interface the API and the worker are given, a no-op outside the stack (development and tests, where there's nothing to restore), and a test pins that production configuration refuses to run without one.

## Affected docs (in the implementation PRs)

- **[10 §7](../10-infrastructure-and-deployment.md):** the local backup section: what, where, retention, the owner's private key, the same-disk limit, the commands, the drill.
- **[16 §5](../16-compliance-ndpa.md):** the local erasure boundary (about 35 days), and the ledger.
- **[08](../08-security.md):** the backup private key among the assets (offline, the owner's); the ledger's integrity and its limit.
- **[spec 0006](0006-envelope-encryption.md):** the destruction boundary's restore rule, now built.
- **[spec 0002](0002-audit-and-outbox.md):** A5's external anchoring, partly met (D12).
- **[19](../19-decision-log.md):** ADR-032 (below).
- **[18](../18-roadmap.md):** item 7.5, and the Phase 0 status.

## ADR-032 (proposed with this spec)

**Local backups sealed to an offline key, Vault on Raft, and a shred ledger outside the platform DB.**
- **Context:** ADR-030 makes backups with a rehearsed restore a local Phase 0 requirement; spec 0006 requires a ledger outside the platform DB so a restore can't re-expose a destroyed tenant.
- **Decision:** D3 (PITR), D4 (Raft), D5 (sealed to an offline X25519 key, built on Node's `crypto`), D7–D8 (the object-locked, mirrored, hash-chained ledger, re-applied at every deploy).
- **Consequences:** every restore needs the owner's private key; a lost private key makes every backup unreadable (the owner keeps two copies, as with the signing key); the local erasure boundary is the backup retention, about 35 days; on one machine, Object Lock and the hash chain give protection against mistakes and evidence of tampering, not immutability against the machine's owner.

## Out of scope

- **Per-tenant logical exports** (docs/10 §7) and tenant export on offboarding: Phase 1's lifecycle work.
- **Off-machine or cloud copies:** ADR-030; the owner's separate media is the only off-disk copy.
- **A per-tenant KEK**, which would make erasure complete at once (spec 0006's tracked option).
- **Shortening the erasure boundary** by keeping `tenant_data_key` out of long-retention backups (spec 0006's tracked option).
