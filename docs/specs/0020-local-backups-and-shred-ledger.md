# Spec 0020: Local backups with a rehearsed restore, and the shred ledger

**Status:** **Accepted (2026-10-22)** by the owner: revision 8, D1–D15 and BK1–BK17 as written. **PR A** (the destruction protocol, the durable ledger, recovery and its re-apply step) may proceed; **PR B stays blocked** until PR A's acceptance criteria (BK1, BK2, BK11–BK17) are implemented, verified and merged.
- **Revision 1** was reviewed by the owner on 2026-10-22: D1–D5 and D9–D11 approved as written.
- **D6** is to be made precise: the erasure boundary holds only with a real schedule and pruning.
- **D7–D8** are **blocking**: an accepted destruction must survive the loss of the whole stack.
- **D12** is to be described as a checkpoint, not as anchoring.
- **Revision 2** rewrites D6, D7, D8 and D12, adds D13 and BK11–BK13, and changes the Design accordingly. The owner reviewed it on 2026-10-22: D6, D12 and D13 correct, the destruction-loss scenario addressed, one change asked for before approval: explicit concurrency control.
- **Revision 3** adds D14 (a host-side lock serializing destruction, recovery and the backup's ledger snapshot; preconditions re-checked inside the transaction) and BK14. D1 now keeps PR B blocked until PR A is implemented and verified. The owner reviewed it on 2026-10-22: D14 approved; two amendments asked for before approval.
- **Revision 4** makes D8 handle a crash after the transaction commits but before `committed` is durable (matching the database's evidence, or replaying), and makes the shard-side guarantee explicit with a grace period (D15). Adds BK15 and a named BK11 case. The owner reviewed it on 2026-10-22: D8, D14 and D15 approved; two details asked for before approval.
- **Revision 5** puts BK15 in PR A's merge gate (D1), and makes D8 establish an **authoritative** ledger before recovery, failing closed when it can't (BK16). The owner reviewed it on 2026-10-22: both approved; one correction asked for: `ledger accept` would have let an attestation stand in for completeness.
- **Revision 6** removes `ledger accept`. The owner's commands are either **guarantee-preserving** (`rebuild-destination`, `remove-destination`, allowed only from a readable configured destination's own copy) or an **explicit waiver** of the guarantee (`ledger waive`). Nothing can promote a backup set's or the bucket's copy. BK16 is rewritten with its permitted and rejected cases; BK17 covers the waiver. The owner reviewed it on 2026-10-22: approved; one clarification asked for: how the waiver starts a new generation when no destination is readable.
- **Revision 7** defines that bootstrap: the owner names the new generation's destinations, its `genesis` must be durable and verified on all of them before anything changes, and the old history is never claimed complete. It makes "durable" mean written, `fsync`ed and read back verified, throughout D7. BK17 gains the cases. The owner reviewed it on 2026-10-22: approved; one addition asked for: crash injection for the waiver protocol itself.
- **Revision 8** gives the waiver explicit phases (W1–W4) with one point at which a generation becomes authoritative, makes each phase recoverable or inert, and adds BK17's crash cases.
- **PR B1** is merged (#103, then #104 with the fixes the owner's run found) and running on the owner's stack since 2026-10-24: Vault on Raft, and the first sealed set. Its 18 decisions made while building are recorded as approved by the owner's go-ahead to merge #103 (2026-10-24). See "Implementation notes (PR B1)". **PR B2** (the rehearsed restore and the shred drill): its plan ("Plan (PR B2 …)", B2-1 to B2-17) was approved by the owner on 2026-10-25. B2a (status, the deploy's warnings, the schedule) is being built first.
- **PR B's plan** (B-1 to B-17, below) was **approved by the owner on 2026-10-24, all as written**: the B1/B2 split with pruning, BK14's fourth case, D7's external-drive rule and every image subcommand moved into B1, and the amendments to D3, D5 and D9 made above.

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

**The property this spec exists for:** once a destruction has been reported as done, no restore and no loss can silently undo it, including the loss of the whole stack at any moment.

## Terms

| Term | Meaning |
| ---- | ------- |
| **Stack failure domain** | Everything a broken or lost stack takes with it: its containers, its Docker volumes (the platform DB, Vault, SeaweedFS, the ledger bucket), and the Docker VM's disk image. |
| **Durable ledger** | The ledger's copies **outside** the stack failure domain, as plain files on the host: the primary under `~/.univarse/ledger/`, and every additional destination the owner configures (D7). |
| **Accepted destruction** | One that `stack:keys destroy` has reported as done. Never before its `committed` record is durable (D7). |

## Decisions

| #   | Decision | Recommendation |
| --- | -------- | -------------- |
| D1  | **Two PRs, the ledger first.** **A:** the destruction protocol and its durable ledger, recovery, and the re-apply step in every deploy. **B:** backups, the restore, and the rehearsal, with a shred drill. | **Approved (revision 1).** No restore may exist before the ledger that makes restoring safe. Ledger first also protects the stack at once: any deploy re-applies destructions. **PR B stays blocked until PR A is implemented and verified** (its BK1, BK2 and BK11–BK17 met, BK15 included, since D14 rests on D15's guarantee, and merged). |
| D2  | **What a backup holds.** A *backup set* is: PostgreSQL (both databases, physically, D3); Vault's storage (a Raft snapshot, D4); SeaweedFS's **clean** bucket (quarantine is transient and is rescanned); the parts of `~/.univarse/stack` a restore needs (`secrets.json`, `vault-init.json`, the internal `certs/`, the edge CA in `edge/`); a copy of the durable ledger; and a manifest. **Not** backed up: Valkey (not a system of record, docs/10 §7), ClamAV's database, Caddy's data, rendered files (the deploy re-renders them), the local registry (releases are rebuilt and re-signed, and the record names their digests). | **Approved (revision 1).** The minimum that rebuilds the running stack exactly, with nothing re-creatable. |
| D3  | **PostgreSQL: physical base backups plus continuous WAL archiving**, so a restore can reach any point in time (PITR) since the oldest base backup kept. `archive_mode = on`, `archive_command` writing each WAL segment to a staging volume (`pg-wal-staging`), from which the host seals and ships it to the backup destination's WAL area (B-2); `pg_basebackup` for each set. | **Approved (revision 1); amended by B-2 (2026-10-24):** the container can't seal, so the host ships. Local RPO about 20 minutes while the machine runs; unshipped WAL is inside the stack failure domain. docs/10 §7 is PITR with a 15-minute RPO; rehearsing the same mechanism locally is the point. |
| D4  | **Vault moves to integrated (Raft) storage, single node**, so `vault operator raft snapshot save` takes a consistent copy while Vault runs. The existing file storage is migrated once (`vault operator migrate`, offline, Vault stopped), with a backup of the old volume kept until the migrated Vault is verified. | **Approved (revision 1).** The file backend can't be copied consistently while running. Production is Raft (docs/10 §3). |
| D5  | **Every backup set is sealed to the owner's backup public key.** Each artifact is encrypted with a fresh random key (AES-256-GCM, streamed in authenticated chunks, numbered and with a final-chunk flag, so truncation and reordering fail), and that key is wrapped to an **X25519 public key** (ECDH, HKDF-SHA-256). The public key sits in the repository, the **private key only with the owner, offline**, like the signing key: `pnpm stack:backup keygen` writes it to a path the owner chooses, once, and never into `~/.univarse/stack`. The private key is encrypted with a passphrase (`UNIVARSE_BACKUP_KEY_PASSPHRASE`, B-5). A restore asks for its path. Built on Node's `crypto`, no new tool. | **Approved (revision 1); the passphrase added by B-5 (2026-10-24).** A stolen backup, or a stolen `~/.univarse/stack`, reveals nothing. |
| D6  | **Where backups go, the schedule, and the real boundary.**<br>• **Where:** `~/.univarse/backups/` by default, owner-only, or a path the owner sets (an external drive).<br>• **Schedule:** daily. `pnpm stack:backup schedule` registers a daily Windows Task Scheduler task, which the owner approves. Each backup prunes at its end (7 newest daily sets, 4 newest weekly, the WAL back to the oldest set kept), so retention never depends on a separate step.<br>• **The boundary is measured, not assumed:** `pnpm stack:backup status` reports the newest set's age and the **actual erasure boundary**, the age of the oldest retained set. Every deploy warns when the newest set is older than 26 hours.<br>• **The documented figure:** with the daily schedule running, the boundary is about 35 days (4 weekly sets); without it, it is whatever the retained sets make it. | **As revised.** The owner's review: "about 35 days" only holds if backups and pruning actually run. So the schedule is the default, pruning is part of every backup, and the boundary is reported from the real sets. **Stated limit:** a backup on the same disk survives a broken stack, a bad migration or an operator mistake, but not the loss of the disk; only the owner's copy on separate media does. |
| D7  | **The destruction protocol: nothing is reported done before it is durable outside the stack.** Destructions in the stack run only through the host-side `pnpm stack:keys destroy <tenant> [--version n]`. The API and worker can't write the host, so in production they refuse to destroy keys themselves, both the in-container `keys` CLI and any in-app path, unless the protocol's job runs them (Design). Each destruction has an id (`op`), and three records in the **durable ledger** (hash-chained JSON lines, never key material). Each is **durable** on a destination only once written, `fsync`ed, read back and its chain verified there, on **every** configured destination, before the next step:<br>1. **`pending`** `{op, tenant, versions, requested_at, preconditions}`, written after the read-only precondition checks pass (E7's for a retired version), and **before** the database is touched;<br>2. the database transaction: the keys set `DESTROYED`, wraps erased, the platform audit event, and a `key_destruction(op, …)` row, all together, idempotent by `op`;<br>3. **`committed`** `{op, destroyed_at, audit_event_id, chain heads}`, written after the transaction commits; **only then** does the command report success.<br>If step 2 fails for a known reason (a refused precondition, a definite rollback), the command writes **`aborted`** `{op, reason}`, then reports the failure.<br>**Destinations:** the primary `~/.univarse/ledger/`, outside the stack failure domain, plus every destination the owner configures (an external drive is recommended, and is the default when the backup destination is one). The ledger records its own configuration: its first entry (`genesis`) gives it an id, and each destination's copy names its destination id; adding or removing a destination is itself a chained entry, written to every destination. So any copy says which destinations must exist, and a recreated or swapped copy is recognisable. A destination that can't be written stops the protocol before step 2, or, after step 2, keeps the command from reporting success. Every entry is also copied into the stack's object-locked bucket (`uv-shred-ledger`, verified on SeaweedFS 4.48), as an extra copy for evidence, **never relied on** for durability. | **As revised (blocking in revision 1).** The owner's failure sequence ran: the destruction reaches the bucket, the stack's storage is lost, an older backup is restored, and nothing remembers the destruction. Now an accepted destruction always has a `committed` record outside the stack's storage, written before success is reported. A crash between the steps leaves a `pending` record, which recovery rolls forward (D8): **a pending destruction is completed, never forgotten**. **Stated limits:**<br>• the primary copy shares the machine's physical disk, so only an external destination survives the loss of the disk;<br>• a destination's copy replaced by an earlier version of itself, while every other destination is also lost and the database is older too, can't be told from a current one; the other destinations and the database's `key_destruction` rows are the checks against it;<br>• on one machine, the owner (root) can still edit files; the hash chain makes that visible, not impossible. |
| D8  | **Recovery, re-apply, and failing closed.** One routine, run by every deploy (after the migrate job, before the API and worker start), by every restore (D9), and on demand (`pnpm stack:keys recover`):<br>1. **establish the authoritative ledger.** Only the configured destinations' own copies can be authoritative. The latest configuration entry names those destinations, and each copy's `genesis` must carry the ledger's id. Recovery proceeds only when **every configured destination is readable**, each chain verifies, and the copies agree: equal, or one ahead of the others by at most the single operation that was being written when a crash came. Because no destruction is accepted until it is durable on every configured destination (D7), such a set is current by construction.<br>&nbsp;&nbsp;**Never authoritative:** a backup set's copy is a snapshot from the past, and the bucket is inside the stack. A restore reads them too, and their entries can add re-destructions to the union, but they are never accepted as proof that every accepted destruction is represented;<br>2. for each `op`: **`aborted`** → nothing; **`committed`** → make sure its keys are `DESTROYED` with wraps erased (re-destroy if a restore brought them back), audited; **`pending` with no outcome**, decided by the database's own evidence:<br>&nbsp;&nbsp;◦ **a `key_destruction(op)` row exists** (the transaction committed, then the command stopped before `committed` was durable): verify it **matches** the pending record and the database: the same tenant and versions; the audit event it names exists and records that destruction; every listed key is `DESTROYED` with its wrap erased. If all match, append `committed` idempotently. **Any mismatch is conflicting evidence: stop;**<br>&nbsp;&nbsp;◦ **no row exists** (the transaction never committed, or a restore took the database back before it): **roll forward**: re-check the recorded preconditions inside a new transaction (D14); if they hold, complete the destruction and append `committed`; if they don't, stop;<br>3. append to every destination nothing but what step 2 completed.<br>**It fails closed**, stopping the deploy or restore before the app starts, on any of: **no authoritative ledger can be established**, that is, a configured destination unreadable (for example the external drive not connected), missing, empty or recreated (its `genesis` doesn't match), or out of step with the others beyond the one in-flight operation, **even when a valid but older copy, a backup set's or the bucket's, is at hand**; a chain that doesn't verify; copies that diverge (neither a prefix of the other); a `pending` op whose preconditions no longer hold; a `committed` op whose keys can't be destroyed; a database holding a `key_destruction` row for an `op` the ledger lacks; a `key_destruction` row that doesn't match its pending record, its audit event or the keys' state. Each names the op, or the destination, and the owner's choice.<br>**The way out is the owner's, explicit and recorded, never automatic, and it never claims what it can't establish.**
**Guarantee-preserving** commands rest on D7's invariant: no destruction is accepted until it is durable on every configured destination, so any one configured destination's own copy holds every accepted destruction. They need such a copy: one that is readable, carries the ledger's `genesis`, verifies, and is consistent with the database's own evidence (no `key_destruction` op it lacks).
• **Reconnect** the destination: nothing else is needed.
• `pnpm stack:keys ledger rebuild-destination <path>` recreates a lost or emptied destination from such a copy. For example, the primary is rebuilt from the external drive.
• `pnpm stack:keys ledger remove-destination <path>` drops a destination that is gone for good, while such a copy remains. The configuration change is a chained entry.
Both are refused when no configured destination's own copy is readable. **A backup set's copy or the bucket's can never be promoted by any command**, since a destruction accepted after that snapshot would be missing from it, and no attestation changes that.
**The only override is a waiver, not an authority.** `pnpm stack:keys ledger waive --reason … --confirm "destroyed tenants may return"` is for an emergency in which no configured destination can be read, and the owner chooses to run the stack anyway. It:
• records, in a new chained ledger entry and a platform audit event, that **completeness could not be established and the no-resurrection guarantee is waived** for every destruction before that moment, with the copies that were read and the reason;
• re-applies every destruction found in **any** copy (backup sets and the bucket included), as a best effort, not a proof;
• starts a **new ledger generation**, so later destructions are guaranteed again from that point. The bootstrap, under the ledger lock (D14):
&nbsp;&nbsp;1. the owner **names the new generation's destinations** (`--destination <path>`, repeated; at least the primary, and the external drive when the backup destination is one, as D7 requires). Each gets a **fresh directory** for the generation, so nothing of the old generation's remains can mix in;
&nbsp;&nbsp;2. **W1, the candidate.** Each waiver run has its own **attempt id**. A candidate **`genesis`** for it is written to every named destination, in that attempt's own directory. It carries the ledger's lineage id, the generation's number, the attempt id, its destination set, and the **transition record**: the waiver's reason and time, the old generation's last head as far as any copy showed it, and the statement **"the previous generation's completeness could not be established"**. It never claims the old history is complete;
&nbsp;&nbsp;3. **W2, establishment: the one point at which a generation becomes authoritative.** Once the candidate is durable and verified on **every** named destination, an **`established`** record is written to all of them. It carries the attempt id and the **plan**: the ordered list of destructions to re-apply, from the union of every copy read, each with its `op`, tenant and versions. The generation is authoritative only when `established` is durable and verified on every one of its named destinations. A candidate without that, after a crash or a failed write, is **inert**: never authoritative, never completed later, never read as part of another attempt. A retry is a new attempt, with a new id and new directories, so failed attempts never mix. Two attempts both established for the same generation would make recovery stop; the ledger lock (D14) makes that impossible, and the check stays;
&nbsp;&nbsp;4. **W3, the audit record.** The waiver's platform audit event is written next, keyed by the attempt id (unique), so writing it twice is a no-op;
&nbsp;&nbsp;5. **W4, the re-applications.** Each planned destruction is made in its own database transaction, idempotent by its `op` (`key_destruction` is unique; keys already `DESTROYED` with wraps erased are not destroyed again). Each is then recorded as **`reapplied`** `{op}` in the new generation, durable on every destination. Only when every planned `op` is recorded does the waiver report done, and the app may start only then;
&nbsp;&nbsp;**Recovery after a crash in the waiver**, by phase:<br>&nbsp;&nbsp;• **during or after W1, before W2 is complete:** no generation is established, so the stack stays blocked exactly as before the waiver. The owner runs it again, as a new attempt;<br>&nbsp;&nbsp;• **after W2, before W3:** recovery finds the established generation without its audit event, and writes it, idempotently;<br>&nbsp;&nbsp;• **during W4:** recovery resumes the plan. For each `op` without `reapplied`: a matching `key_destruction` row means it was destroyed, so `reapplied` is appended; no row means it is destroyed now, then recorded. Conflicting evidence stops. The app starts only once the plan is complete;
• makes every deploy, `stack:keys recover`, `stack:smoke` and `stack:backup status` report **"no-resurrection guarantee waived since <time>"**, permanently for that generation.
It never runs by itself and is never implied by any other command.
**After a waiver, the new generation is the only authority.** Its `genesis` and configuration entries name its destinations, and every rule above applies to them unchanged. A destruction is reported successful only once its records are durable and verified on **every** destination of the new generation; if any is unavailable, the destruction stops before the database changes. Recovery establishes authority from the new generation's destinations alone; with one of them unavailable it fails closed, and the old generation's copies, the backup sets' and the bucket's never stand in for it. The way out is again a guarantee-preserving command, within the generation, or another waiver, which starts the next one. | **As revised (blocking).** Rolling forward is safe because a `pending` record exists only after the preconditions passed and the operator asked for the destruction; the only thing a crash can lose is the report of it. Rolling back is never done silently: `aborted` is written only when the outcome is known. Every state the routine can't decide is a stop, not a guess. It makes erasure **safe in operation**, not **complete**: the backups taken before the destruction still hold the wrapped keys until they expire (spec 0006's wording, kept). |
| D9  | **The restore is a rehearsal first, into an isolated stack.** `pnpm stack:restore-rehearsal <set> [--to <time>]` restores into a separate compose project (`univarse-restore`), on internal networks only, with no published port and no edge: PostgreSQL, PgBouncer, Vault and SeaweedFS, plus one-shot jobs from the release named in the set's manifest (the keys job and the migrate job's check-only mode), and no API, worker or web (B-10). Its recovery runs on a scratch copy of the ledger, so the real ledger is unchanged (B-11). It never touches the running stack. A restore **over** the running stack (`pnpm stack:restore`) is the same steps against the stack itself, after `stack:down`, and is documented, not rehearsed against live data by default. | **Approved (revision 1); amended by B-10 and B-11 (2026-10-24).** |
| D10 | **What the rehearsal must prove,** recorded as a drill in `docs/ops/drills/`:<br>• every artifact decrypts and matches the manifest;<br>• PostgreSQL reaches the requested point in time;<br>• `rls:check` passes;<br>• every tenant's and the platform's audit chains verify, and match the set's checkpoint (D12);<br>• row counts match the manifest's;<br>• every active tenant DEK unwraps through the restored Vault;<br>• every restored file's SHA-256 matches;<br>• **the shred drill** (D11) holds;<br>• the timings (RTO, and the RPO reached). | **Approved (revision 1).** The same checks as production's quarterly drill (docs/10 §7), locally. |
| D11 | **The shred drill.** In the rehearsal, a drill tenant (`shred-drill`, created for it) has its keys destroyed **after** the backup was taken. Restoring that backup brings its wrapped keys back; the re-apply step must then leave it undecryptable while every other tenant still decrypts. The opposite control: without the re-apply step, the drill tenant's data decrypts (shown, then removed). | **Approved (revision 1).** |
| D12 | **Audit-chain checkpoints, not anchoring.** Each backup set's manifest, and each `committed` ledger record, records the head (`seq`, hash) of the platform audit chain and of each tenant's. A restore's verification compares the restored chains against the set's checkpoint. This is a **backup integrity checkpoint**: it shows a restored set is internally consistent and wasn't partly replaced. It is **not** independent anchoring, because an attacker who can replace a whole set can replace its manifest with it. **Independently protected anchoring stays a separate requirement before GA** (spec 0002 A5), with its own acceptance test, tracked in docs/18. | **As revised.** The owner's review: a head stored beside what it vouches for can be replaced together with it, so it isn't an anchor. |
| D13 | **Proving D7–D8 with crash injection.** The destruction protocol's steps are injected (as the deploy's are, spec 0019 LS3), so a test can stop it after every step, and after every destination write within a step. For each stopping point, and with the stack's storage lost entirely (the platform DB, Vault and the bucket replaced by an older backup's), recovery must either complete the destruction or report it as not accepted, and **an accepted destruction is never undone**. | **As written.** The guarantee is only as good as the failures it was tested against; this tests all of them, in a real database, against a real restore of an older state. |
| D14 | **Concurrency: one ledger lock, and preconditions re-checked inside the transaction.**<br>**The ledger lock** is a host-side, cross-process exclusive lock (`~/.univarse/ledger/.lock`, the same mechanism as the registry lock, spec 0013 LR8: created atomically, holding the holder's name, PID and the process's start time). These hold it, for their whole duration:<br>• `stack:keys destroy`, from before `pending` until after `committed` or `aborted`;<br>• D8's recovery, standalone, in a deploy (the deploy takes it after the registry lock, always in that order, so the two can't deadlock) and in a restore;<br>• a backup, while it copies the durable ledger, so the set holds a **consistent snapshot**: a prefix of the live ledger at a recorded `seq` and hash.<br>A second holder **waits, then refuses**: it never interleaves. A lock whose holder is gone (no process with that PID **and** that start time) may be taken over, and the takeover is logged; any other lock is never broken.<br>**Inside the database transaction**, the destruction re-checks its preconditions **atomically**, so the read-only check before `pending` can't go stale before the mutation:<br>• it locks the tenant's key rows (`SELECT … FOR UPDATE`);<br>• it re-reads their status, and for a retired version (E7) its completed sweep record with no unreadable values, all in the platform DB, in the same transaction;<br>• it refuses an `op` already recorded in `key_destruction`, which is unique, so a repeat is a no-op, never a second destruction.<br>The E7 count of values still carrying the version lives in the tenant shard and can't share the platform transaction. It is re-run inside the transaction's window, and it is safe only because of **D15**, which makes the count unable to rise once a version is eligible. A precondition that fails inside the transaction rolls it back, and the command writes `aborted`. | **As written (the owner's review of revision 2).** The lock makes the ledger single-writer, so its chain can't fork, and recovery can't read it half-written. The in-transaction re-check closes the window between checking and destroying. Every guarantee the platform DB can give atomically is given there, and the one cross-database check is safe by a stated invariant, not by timing. |
| D15 | **The shard-side guarantee: no writer can commit under a retired version once it is eligible for destruction.** New writes never *choose* a retired version: each encryption reads the `ACTIVE` version fresh from the platform DB (`TenantKeyring.activeVersion`). The risk is a writer **already in flight**: it read version `n` while `n` was active, and commits its ciphertext after `n` was retired, after a sweep had counted.<br>**So destroying a retired version is eligible only when:**<br>1. **Every writer finishes within a bound `W`.** PR A establishes it: every code path that writes an encrypted column (the `*_enc` registry, spec 0006) encrypts **inside** the tenant transaction that writes it, and that transaction has a timeout (`withTenantTx`, 10 s today). A test walks the registry's writers and fails on any that encrypts outside its writing transaction, so `W` is that timeout.<br>2. **The version has been `RETIRED` for at least a grace period `G`** (default **1 hour**, configurable, never below `W` plus a 60-second margin), measured from `retired_at` in the platform DB.<br>3. **A sweep that started after `retired_at + G` completed** with no value still carrying the version, and none unreadable (E13).<br>After `retired_at + G`, every writer that could have read `n` as active has committed or failed, and none can read it again, so the count of values carrying `n` can only fall. The sweep in step 3 sees every such value. **Offboarding's `destroyTenantKeys`** destroys every version at once, with the data meant to become unreadable, so it doesn't need D15. | **As written (the owner's review of revision 3).** The guarantee becomes a stated, tested invariant with an explicit bound, not an assumption about timing. One hour costs nothing: retiring and destroying a version is rare, and nothing waits on it. |

## Acceptance criteria

| ID   | Criterion |
| ---- | --------- |
| BK1  | _The protocol (PR A)._ `stack:keys destroy` writes `pending` to every durable destination before the database changes, commits the destruction with its `key_destruction` row and audit event in one transaction, then writes `committed` to every destination, and only then reports success. A refused precondition writes `aborted`. Entries are hash-chained and hold no key material. In production, the API and worker refuse to destroy keys themselves. |
| BK2  | _Recovery and re-apply (PR A)._ The deploy runs D8's routine after the migrate job and before the app. Tests cover each case: a committed destruction whose keys a restore brought back is re-destroyed and audited; a `pending` destruction is rolled forward and gains `committed`; an `aborted` one changes nothing; nothing to do changes nothing. |
| BK3  | _A backup set (PR B)._ `pnpm stack:backup` writes a set with the manifest (versions, sizes, SHA-256 of every artifact, the audit checkpoint, the ledger head, the deployed digests), each artifact sealed to the backup public key (D5), and prunes at its end. A test shows a set's artifacts don't decrypt without the private key, a truncated or reordered artifact fails to decrypt, and no secret value appears in clear in the set or in the command's output. |
| BK4  | _PITR (PR B)._ WAL is archived continuously; a restore to a time between two base backups reaches it (a row written before it is present, one written after is absent). |
| BK5  | _Vault (PR B)._ Vault runs on Raft; the one-time migration from file storage keeps the Transit key (every existing wrapped DEK still unwraps afterwards); a snapshot restored into the isolated stack unwraps every active DEK. |
| BK6  | _The rehearsal (PR B)._ `pnpm stack:restore-rehearsal` proves every D10 check against a real set, leaves the running stack untouched, and records a drill with its timings. It removes the isolated stack afterwards, even when a check fails. |
| BK7  | _The shred drill (PR B)._ D11, both halves: with the re-apply step the drill tenant is undecryptable and every other tenant decrypts; without it, the drill tenant decrypts (the control). |
| BK8  | _Retention and the boundary (PR B)._ Each backup prunes to the 7 newest daily and 4 newest weekly sets and the WAL they need, never the newest set nor WAL a kept set needs. `stack:backup status` reports the newest set's age and the actual erasure boundary; a deploy warns when the newest set is older than 26 hours. `stack:backup schedule` registers the daily task, and a test checks what it registers. |
| BK9  | _Secrets (both)._ The backup private key is never written into `~/.univarse/stack` or the repository; no command prints a secret; a scan of the repository and every command's output finds none of the stack's generated values (spec 0019 LS9's scan). |
| BK10 | _Evidence._ Every BK ID appears in a test or a recorded check. Mutations, each failing its check:<br>• success reported before `committed` is durable (BK1, BK11);<br>• `pending` written after the database change (BK11);<br>• a `pending` op dropped instead of rolled forward (BK11);<br>• a divergent ledger accepted (BK12);<br>• the re-apply step after the app starts, or skipped (BK2);<br>• a set artifact without chunk authentication (BK3);<br>• the private key written beside the backups (BK9);<br>• the shred drill without the re-apply step passing (BK7);<br>• prune deleting the newest set (BK8);<br>• the bucket accepted as the only ledger copy (BK12);<br>• the ledger lock not taken by destroy, recovery or the backup's snapshot (BK14);<br>• the preconditions not re-checked inside the transaction (BK14);<br>• a live holder's lock taken over (BK14);<br>• `key_destruction.op` not unique (BK14);<br>• the commit boundary replayed as a second destruction instead of completed from the row (BK11);<br>• conflicting `key_destruction` evidence accepted (BK11, BK12);<br>• the grace period not enforced, or a sweep started before it accepted (BK15);<br>• a writer encrypting outside its transaction not caught (BK15);<br>• a backup set's or the bucket's ledger accepted as authoritative (BK16);<br>• recovery proceeding with a configured destination unreadable, without a guarantee-preserving command or a waiver (BK16);<br>• `rebuild-destination` accepting a backup set's copy as its source (BK16);<br>• the waiver accepted without its confirmation phrase, or not reported afterwards (BK17);<br>• the waiver applied automatically (BK17);<br>• a generation established with its `genesis` on only some named destinations (BK17);<br>• a post-waiver destruction reported with a new-generation destination unavailable (BK17);<br>• an old-generation copy accepted after a waiver (BK17);<br>• a record called durable without being read back and verified (BK13);<br>• a generation authoritative with `established` on only some destinations (BK17);<br>• an inert attempt's candidate read into a retry (BK17);<br>• the waiver's audit event written twice, or not completed by recovery (BK17);<br>• a re-application repeated after a crash, or the app started before the plan is complete (BK17). |
| BK11 | _Crash injection, including total stack loss (PR A; D13)._ For every stopping point (after `pending` reaches each destination; after the transaction; after `committed` reaches each destination; before success is reported), each combined with **total stack loss** (the platform DB, Vault and the ledger bucket replaced by an older backup's state, the durable ledger kept), recovery leaves every **accepted** destruction in force. A destruction stopped before success is either completed by roll-forward or recorded as not accepted, and is reported to the operator either way. No case leaves an accepted destruction undone. Two cases are named:<br>• **the commit boundary:** the transaction commits, then the command stops before `committed` reaches any destination; recovery finds the matching `key_destruction` row, verifies it, and appends `committed` once, with nothing destroyed twice. Its variants with conflicting evidence (a row for another tenant or other versions, a missing audit event, a key not `DESTROYED`) each stop recovery;<br>• **the older database:** after that same stop, the platform DB is replaced by an older backup's, so no row exists; recovery replays the pending destruction and appends `committed`. |
| BK12 | _Failing closed (PR A)._ The deploy and the restore stop before the app starts, naming the op, on each of: no readable durable destination; a chain that doesn't verify (an edited, deleted or reordered entry); copies that diverge; a `pending` op whose preconditions no longer hold; a `committed` op whose keys can't be destroyed; a `key_destruction` row the ledger lacks. The object-locked bucket alone is never accepted as the ledger. |
| BK13 | _Destinations (PR A)._ A destination that can't be written before the database step stops the destruction with nothing changed; one that fails after it keeps the command from reporting success, and the next recovery completes the records. `fsync` is called on every write, and each record is read back and its chain verified before it counts as durable; a test checks both on the real file system, including a destination that accepts the write but returns different bytes. |
| BK14 | _Concurrency (PR A; D14)._ Tests, each in a real database, with real processes holding the real lock:<br>• **Two overlapping destroy commands** for the same tenant: the second waits, then sees the destruction done and records nothing new, or refuses; for different tenants, both complete, one after the other.<br>• **Recovery racing a destruction:** it waits for the lock, and never acts on a `pending` record whose command still runs.<br>• **A deploy racing a destruction:** the deploy's recovery waits for the lock, in its fixed lock order.<br>• **A backup's ledger snapshot taken during a destruction:** it waits, and the snapshot is a prefix of the live ledger.<br>• **A stale lock** (its holder killed): taken over only when that PID with that start time is gone; a live holder's lock is never broken.<br>• **A precondition broken between the read-only check and the transaction** (a retired version made active again, or its sweep record removed): the transaction refuses it, rolls back, and the command writes `aborted`.<br>• **The same `op` run twice:** the second is a no-op.<br>In every case the ledger's chain verifies, nothing is applied twice, and no accepted destruction is undone. |
| BK15 | _The shard-side guarantee (PR A; D15)._<br>• **The bound:** a test walks every writer of an encrypted column and fails on any that encrypts outside its writing transaction.<br>• **The window, staged:** an injected slow writer reads version `n` as active, then holds its transaction open while `n` is retired, then commits its value under `n`.<br>• **What must hold:** destroying `n` is refused before `retired_at + G`, and refused after it on the strength of a sweep that started before it. A sweep started after it re-encrypts the slow writer's value, the count reaches 0, and only then is the destruction allowed.<br>• **Reaching the bound:** a writer that would outlive `W` is ended by its transaction timeout, and its value is never written.<br>• **Configuration:** `G` below `W` plus the margin is refused. |
| BK16 | _The authoritative ledger, and the owner's guarantee-preserving commands (PR A; D8)._<br>**Blocked, kept from revision 5:** the deploy and the restore stop before the app starts on each of:<br>• the primary lost (deleted, or recreated empty) **and** the external destination unreachable, although a valid, older backup-set ledger and the bucket are at hand;<br>• a destination swapped for an older copy of itself (out of step with the others);<br>• a copy whose `genesis` doesn't match;<br>• a configured destination missing.<br>**Permitted, the guarantee kept:**<br>• the primary lost, the external drive readable and consistent: `rebuild-destination` recreates the primary from it, and recovery then proceeds with no waiver;<br>• the external drive gone for good, the primary readable and consistent: `remove-destination` drops it, and recovery proceeds;<br>• every configured destination readable and agreeing: recovery proceeds with no owner step.<br>**Rejected, and nothing changes:**<br>• `rebuild-destination` or `remove-destination` with no configured destination's own copy readable;<br>• `rebuild-destination` from a backup set's copy or the bucket's;<br>• a source copy that lacks a `key_destruction` op the database holds;<br>• any attempt to make a backup-set snapshot or the bucket authoritative.<br>Every permitted command is recorded in the chain and the platform audit. |
| BK17 | _The waiver (PR A; D8)._ With no configured destination readable:<br>• `ledger waive` without its exact confirmation phrase, or without a reason, is refused;<br>• with them, it records the waiver in a new chained entry and a platform audit event ("completeness could not be established", the copies read, the reason), re-applies every destruction found in any copy, and starts a new generation;<br>• every later deploy, `recover`, `stack:smoke` and `stack:backup status` reports "no-resurrection guarantee waived since <time>";<br>• a destruction made after the waiver is guaranteed again: BK11's cases hold for it;<br>• no other command, and no deploy or restore, ever waives by itself.<br>**The bootstrap:**<br>• with every named destination writable, the new `genesis` is durable and verified on each, carries the transition record (with "could not be established"), and lives in a fresh directory per destination;<br>• with one named destination unwritable, the waiver fails: no generation exists, the database is untouched, and the deploy stays blocked;<br>• a waiver naming no destination, or fewer than D7 requires, is refused.<br>**After the waiver:**<br>• a destruction with a new-generation destination unavailable stops before the database changes, and nothing is reported;<br>• recovery with a new-generation destination unavailable fails closed, **although the old generation's copies, a backup set's and the bucket's are at hand**;<br>• reconnecting it, or a guarantee-preserving command within the new generation, lets recovery proceed;<br>• an old-generation copy is never accepted as the new generation's authority.<br>**Crash injection in the waiver itself** (its phases injected, as the destruction's are, D13), each combined with the stack's loss where it applies:<br>• **after the candidate `genesis` reaches one destination, before the others:** no generation is authoritative; the deploy stays blocked; a retry is a new attempt in new directories, and the inert attempt's candidate is never read, completed or mixed in;<br>• **after the candidate is on every destination, but `established` on only some:** still not authoritative; the same as the case above;<br>• **after `established` is durable everywhere, before the audit event:** recovery writes the audit event once; a second recovery writes nothing more;<br>• **during the re-applications (after some `op`s, before others; and between an `op`'s transaction and its `reapplied` record):** recovery resumes the outstanding ones only. No key is destroyed twice and no `op` recorded twice, the chain verifies, and the app starts only once every planned `op` is recorded;<br>• **conflicting evidence during resumption** (a `key_destruction` row that doesn't match its planned `op`): recovery stops. |

## Design

**Files.**

- `tools/stack/src/destroy.ts`: `pnpm stack:keys destroy|recover`, the protocol (D7) with its steps injected.
- `tools/stack/src/ledger.ts`: the durable ledger: append with `fsync`, verify, compare copies, the bucket copy.
- `tools/stack/src/recover.ts`: D8's routine, used by the deploy, the restore and `recover`.
- `tools/stack/src/backup.ts`: `pnpm stack:backup [keygen | schedule | status]`, pruning at the end of each backup.
- `tools/stack/src/seal.ts`: D5's streamed sealing and unsealing.
- `tools/stack/src/restore.ts`: `pnpm stack:restore-rehearsal` and `pnpm stack:restore`.
- `infra/stack/compose.yml`: PostgreSQL's WAL archiving, Vault on Raft.
- `infra/stack/restore.compose.yml`: the isolated rehearsal stack.
- `infra/backup/backup.pub`: the owner's backup public key, committed after `keygen`.
- `docs/ops/drills/`: the drill records.
- A platform migration: `key_destruction(op, tenant_id, kind, versions, reason, destroyed_at, audit_seq)`, written by the destruction's transaction (expand only; built in A1, see below).

**Locks.** Two host-side locks, always taken in this order when both are needed: the registry lock (deploy, release, prune, backup), then the ledger lock (destroy, recovery, the backup's ledger snapshot). Nothing takes them in the reverse order.

**Where the database step runs.** The host-side command runs step 2 through a one-shot job from the deployed API image, as the migrate job runs. It runs on the stack's networks, with the platform app role, and with `op` passed in. In production configuration, the in-container `keys destroy` and `destroyTenantKeys` refuse unless the job's `op` is set, and so does any in-app path. Phase 1's console will request a destruction; a host-side executor will carry it out with this same protocol.

**The order of a backup.** Take the lock (the same registry lock a deploy and a prune use, so a backup never races a deploy) → write the manifest's header → `pg_basebackup` → the Vault Raft snapshot → the clean bucket's objects → the stack directory's parts → the durable ledger's copy, under the ledger lock (D14), and the audit checkpoint → seal each artifact as it is written → write the manifest last, sealed → prune → release the lock. A set without its manifest is incomplete and ignored.

**The order of a restore.**

1. Unseal the set with the owner's private key.
2. Verify the manifest and every artifact's hash.
3. Restore PostgreSQL to the point.
4. Restore Vault's snapshot, and unseal it with the restored `vault-init.json`.
5. Restore the files.
6. Run the migrate job's checks (`rls:check`).
7. **Run D8's recovery,** with every ledger copy it can read.
8. Only then, for a real restore, deploy the release named in the set's manifest.

## Implementation notes (PR A1: the database and crypto core)

PR A was split, with the owner's approval, into **A1** (this part: the database's evidence, the in-transaction re-checks, D15), **A2** (the host-side ledger, its lock, `stack:keys destroy`, recovery, the deploy step and the destination commands) and **A3** (the waiver). A1 changes nothing on the host and adds no operator step.

- **`key_destruction`** (platform migration `20261022120000_key_destruction`, expand only): `op` (the primary key), `tenant_id`, `kind` (`TENANT` | `RETIRED`), `versions`, `reason`, `destroyed_at`, and `audit_seq`, a unique foreign key to the destruction's own `platform_audit_event` (its chain position, the platform audit's stable key). It's written in the destruction's transaction, after its audit event. The app role can't update, delete or truncate it.
- **Both destroy functions take the op** (`destroyTenantKeys(…, { op })`, `destroyRetiredKey(…, { op, … })`):
  - **Inside one platform transaction:** the op's record is checked first. The same op with the same tenant, kind and versions is a no-op: 0 destroyed, or `false`, with nothing audited. A record that disagrees throws `DestructionConflictError`.
  - **Under `FOR UPDATE`, the key rows are read again.** For a retired version, the sweep record is read too, under `FOR SHARE`, so a concurrent re-request waits.
  - **The decision is made on what is locked, then the evidence is recorded:** the destruction, its audit event (with the op in its metadata), and the `key_destruction` row.
  - **The retired path does more:** it runs the read-only check first, and counts the values again inside the transaction. Any precondition that no longer holds rolls everything back. `afterPrecheck` is the test seam for the window between the check and the transaction (BK14).
  - **A repeat is answered from the record** before any check, so it succeeds whatever the key's state is now.
- **D15**, as `retiredKeyProblem` (pure, unit-tested). A version may be destroyed only when all of these hold:
  - it is `RETIRED`;
  - `now ≥ retired_at + G`;
  - the tenant's sweep record has `started_at ≥ retired_at + G`, `completed_at ≥ started_at`, and `unreadable_remaining = 0`.

  Otherwise the destruction is refused with `not_retired`, `grace_period`, `sweep_pending` or `values_remain`.
  - **The grace period `G`:** `RETIRED_KEY_GRACE_MS`, default 1 h. Both `loadConfig` and the function refuse a `G` below `TENANT_TX_TIMEOUT_MS` (10 s, now a named export of `@univarse/db`) plus 60 s.
  - **A sweep after `retired_at + G` is requested explicitly:** the new `keys resweep <slug>`. The worker then runs it as usual.
- **The writer bound `W` (BK15)** is a static guard over the API's production source, with full type information (`testing/writer-bound-guard.ts`, `writer-bound.spec.ts`). Every call to `FieldCrypto.encrypt`, `reencrypt` or `activeVersion` must be awaited, and must be either:
  - (A) directly inside the callback given to `ShardRegistry.tx` or `withTenantTx`; or
  - (B) an argument of a call on a tenant transaction.

  Aliasing, destructuring or element access is refused. A tenant transaction with its own timeout must be a reviewed long transaction that never encrypts. Today that's one: the outbox delivery's.

  **A real gap was found and fixed here:** the key sweep read the active version *before* opening the transaction that writes under it. The read now happens inside that transaction. Putting the old code back fails the guard.
- **The production guard:** `KeyDestruction` (`key-forget.ts`) is the only production importer of either destroy function. Its `shredTenantKeys` and `destroyRetired` both refuse (`DestructionRefusedError`), before reading anything, in two cases:
  - the op is not a UUID;
  - in production, the op is not the one the destruction job was started with (`UNIVARSE_DESTRUCTION_OP`).
- **The CLI:** `destroy-retired` is replaced by:
  - `keys destroy <slug> --op <uuid> [--version <n>]`: without a version, the whole tenant; with one, a retired version. It prints one JSON line (`op`, `kind`, `destroyed`, `committed`, and the forget report), for A2's job to read;
  - `keys destroy-check <slug> --version <n>`: the read-only precheck, as JSON, exit 1 when not eligible;
  - `keys resweep <slug>`.
- **Tests:**
  - **Unit:** the D15 rule's every branch and its boundary; the grace floor; the job guard; the config.
  - **Integration (real platform DB, shard and Vault):**
    - op idempotency and conflicts, for both kinds;
    - the record is append-only;
    - the BK14 cases of a precondition broken between the check and the transaction: a late value under the version, and a re-requested sweep;
    - BK15's staged window: a slow writer commits under `n` after the retirement and after a sweep. The destruction is refused before `G`, then on the strength of that earlier sweep, and is allowed only after a sweep started past `retired_at + G` moves the value;
    - a writer that outlives `W` is ended by its timeout and writes nothing;
    - the CLI's `destroy`, run as a built process with Valkey down.
- **Mutations caught:**
  - the sweep's start compared with an off-by-one boundary;
  - unreadable values ignored;
  - a completion older than its start accepted;
  - no grace period;
  - the grace floor without its margin;
  - the active version read outside the sweep's transaction (the guard).

## Implementation notes (PR A2: the host-side ledger, the protocol, recovery, the deploy step)

Built as approved: decisions A2-1 to A2-13, with a 10-year retention for the bucket copy. A2 changes the API image (the `keys` CLI gains `evidence`, `reapply`, `ledger-audit`, `ledger-copy`, and `destroy-check` for a whole tenant), so a release follows it.

**What runs where.**

- **The host** (`tools/stack/src/ledger/`):
  - the chain (`chain.ts`);
  - one destination's copy and its durability (`store.ts`);
  - the authoritative ledger (`ledger.ts`);
  - the lock (`lock.ts`);
  - the protocol and recovery (`protocol.ts`);
  - the configuration commands (`commands.ts`);
  - the database step's runner (`job.ts`);
  - and `pnpm stack:keys` (`src/keys.ts`).
- **The database step** is the `keys` compose job: the deployed API image, its own `keys.env` (the API's settings plus the bucket identity's credentials, which no other process holds), and the `app` network, through PgBouncer.

**The ledger on disk.**

- **Layout:** each destination holds `<dest>/<ledgerId>/gen-0001/`, with two files:
  - `ledger.jsonl`: canonical JSON, one entry per line, identical bytes on every destination;
  - `destination.json`: the copy's identity.
- **The primary** is `~/.univarse/ledger/` (override: `UNIVARSE_LEDGER_DIR`), id `primary`. Other destinations get `dest-<8 hex>`.
- **Entry types:** `genesis`, `config` (add, remove, rebuild), `pending`, `committed`, `aborted`, `reapplied` (a committed destruction made again after a restore).
- **What is never in an entry:** key material or wrapped keys. An entry holds ids, slugs, versions, statuses, times, audit sequence numbers and reasons.

**What a crash can leave, and what agreement accepts.**
- **Exactly two shapes.** A copy may be behind the others by:
  - one record (any record is written to every destination before the next one starts); or
  - a `pending` that couldn't reach a destination, followed by its `aborted` where it did.
- **Anything else is refused,** even if every entry belongs to one op. An example is `pending` and `committed` missing together: `committed` is written only once `pending` is durable everywhere, so only a swapped older copy can look like that.

The unit tests found this. The first version accepted "entries of one op", and a destination swapped for its older self passed.

**Decisions made while building (for approval).**

1. **`pnpm stack:keys ledger abandon <op> --reason … --confirm "its outcome is not established"` is an explicit, recorded waiver for one op, never an `aborted`.** D8 stops on a `pending` op whose preconditions no longer hold, and names "the owner's choice". This is that choice.

   **Revised after the owner's review of A2.** The first version wrote `aborted` when the database held no row. But a missing row doesn't show the transaction never committed: an older database may have been restored since, and then its keys may be usable again. So now:
   - **What it writes:** an `abandoned` entry with the owner's reason and a fixed statement, audited as `crypto.ledger.op_abandoned`. The statement says the outcome was not established, that the op may have committed before an older database was restored, and that the guarantee does not cover it. It never says nothing was destroyed.
   - **Afterwards:** every recovery and every `status` reports the op as abandoned. A later destroy isn't blocked by it. If the op's row turns up after all (a newer database back), recovery records the op as committed, and its guarantee holds again.
   - **What it is refused for:** an op whose row the database holds (recovery records it), an op with an outcome, a second time, and an adoption (below).
2. **The ledger's history before it existed (revised after the owner's review of A2): reconciled from the database's evidence, or `init` refuses.** `init` reads every destroyed key and every destruction audit event (`keys evidence --legacy`). The history is trustworthy only when it is consistent:
   - every destroyed key has its wrap erased and an audit event recording its destruction;
   - every destruction audit event's keys are destroyed now;
   - no such event names an op that has no row.

   **When it is consistent,** genesis records it: the adopted destructions, each with its own op, and a statement. The statement says they are recorded from this database's evidence at that time, and that any a restore had already undone before then cannot be known. Each adoption is then written like a destruction: `pending`, then `keys adopt` (the row and a `crypto.tenant_key.adopted` audit event, nothing destroyed, refused unless every version is already destroyed), then `committed` (`by: adoption`). From then on it is an accepted destruction like any other: a later restore that brings its keys back is undone by recovery. If `init` stops part-way, recovery completes genesis's plan, so no adoption is left out. Every recovery and `status` repeats the statement.

   **When it isn't,** `init` refuses and lists each problem. An event whose keys are live again is exactly what a restore before the ledger would leave, and a genesis must not imply that history was captured when it wasn't.
3. **The first deploy with A2: `pnpm stack:deploy <record> --init-ledger`.** `init` needs the database's evidence, and the evidence needs the new image. So the owner's one-time init runs inside that deploy, right after the migrate job, then recovery. Without the flag, a deploy with no ledger stops, and its message names the flag. `pnpm stack:keys ledger init` is the same command, standalone.
4. **Deploys wait up to 10 minutes for the ledger lock.** A destroy holds it for a minute or two, and a deploy shouldn't fail because one was running. Commands run on their own wait 30 s.
5. **PgBouncer and Valkey start, and restart if their configuration changed, before recovery.** The keys job connects through PgBouncer.
6. **Secrets added since a stack was initialised are generated by the deploy itself** (`upgradeSecrets`), names printed, values never. That is how the bucket identity's credentials arrive without `stack:init --rotate`.
7. **The bucket copy is written by the keys job under its own SeaweedFS identity.** The identity has `Write` on `uv-shred-ledger` only, cannot read or list it, and owns the bucket. The bucket is created with object lock, entries are retained in COMPLIANCE mode for 10 years, and the host remembers how far it copied (`.bucket-copied.json` beside the primary). A failed copy is reported and retried by the next destroy or recovery, and never blocks.
8. **A committed destruction whose tenant has no keys in this database is in force, and is reported, not re-applied.** After `stack:init --rotate` resets the demo database, the tenant doesn't exist, so there is nothing to decrypt with. Re-applying would fail on the foreign key and stop every deploy.
9. **When recovery re-applies a `RETIRED` destruction whose version a restore made ACTIVE again, the version is destroyed.** The tenant then has no active key until one is provisioned. Recovery says so in a WARNING line. The accepted destruction outranks the tenant's ability to write.
10. **The ledger lock reads a process's start time explicitly.** On Windows the answer is `GONE`, `UNREADABLE` or the time. A process whose start time can't be read (another user's), or an OS other than Windows and Linux (no `/proc`), is never taken for a gone holder: the lock is left alone and the command fails. The first version took PowerShell's exit code for "gone", and the tests caught it.
11. **Takeovers are serialized by their own atomic directory, with the owner re-read inside it.** Otherwise a slower taker could move aside a lock that a faster one had just taken over.

**Tests.**

- **Unit, in `tools/stack`:**
  - the chain (edits, deletions, reordering, re-hashing, a second genesis, torn or non-canonical lines);
  - durability on the real file system: every write fsynced, counted through the injected Node functions; a destination that accepts a write and returns other bytes; a write that fails; a copy changed underneath;
  - authority: BK16's blocked cases, agreement, levelling.
- **The protocol, against the in-memory database model** (`fake-keys-db.ts`):
  - every crash point (each destination write of `pending` and `committed`, both sides of the transaction, the report), each with and without total stack loss, checking that the accepted destruction holds and the stopped one ends committed;
  - BK11's two named cases and the conflicting-evidence variants;
  - BK2's re-apply, roll-forward, aborted and nothing-to-do cases;
  - BK12's fail-closed cases;
  - BK13's destination failures, before and after the database step.
- **The lock, between real processes:** a live holder never broken; a second taker waits, then takes the lock once it is released; a killed holder taken over and logged; a reused PID; release never removes another run's lock. Then the protocol under the real lock: overlapping destroys of one tenant and of two; recovery racing a destruction.
- **The configuration commands:** BK16's permitted and rejected cases, and that each is chained and audited.
- **Integration, a new CI step after the API's suites** (`pnpm --filter @univarse/stack test:ledger`, CI's disposable database only):
  - the protocol with the real built `keys` CLI and the real platform database;
  - BK11's two named cases;
  - a precondition broken between the check and the transaction (BK14);
  - a re-apply after a staged restore.

**Mutations caught (38 of 38, each run against its own test file; after the owner's review of A2, 14 more for the two revisions):**
- **agreement:** any suffix accepted; a diverging copy accepted;
- **the store:** a swapped destination id accepted; no read-back; the chain's hash not checked;
- **destroy:** `pending` written after the database; an unknown outcome written as `aborted`; no `aborted` after a stopped `pending`; success reported before `committed` was durable;
- **recovery:** a row the ledger lacks ignored; a pending row accepted without checking it; versions not compared; committed ops never re-applied; a refused roll-forward taken as done; an aborted op with a row accepted; a missing tenant re-applied (decision 7 undone);
- **abandon:** allowed for a committed op;
- **the lock:** never taken over; a live holder broken;
- **the commands:** init over existing destructions; rebuild without the evidence check; rebuild from any copy; remove without the rest being authoritative;
- **the API:** `KeyDestruction.reapply` without the job guard; `KeyDestruction.adopt` without it;
- **the waiver:** written as `aborted`; no confirmation; an abandoned op not reported; its row ignored; a destroy blocked by it; abandoning an adoption;
- **the history:** live keys accepted; an unaudited destruction accepted; an unerased wrap accepted; an op without a row accepted; an inconsistent history accepted by init; genesis's plan not completed by recovery; adoptions not recorded.

Three survived the first run, each a test that wasn't isolating its case or a case no test covered. Each now has one:
- versions not compared;
- an aborted op with a row;
- removal with the rest not authoritative.

**Not in A2:**
- the waiver (A3, BK17: built, see below);
- the backup's ledger snapshot under the lock (BK14's fourth case), which comes with the backup itself in PR B.

## Implementation notes (PR A3: the waiver)

Built as approved: decisions A3-1 to A3-12. A3 changes the API image: the `keys` CLI gains `ledger-bucket-read` and `ledger-waiver-audit`, `ledger-copy` accepts a later generation's path, and a platform migration adds `ledger_waiver`. So a release follows it.

**What runs where.**

- **The host** (`tools/stack/src/ledger/`):
  - `waiver.ts`: the command, the plan, W1 to W4, and `completeWaiver` (W3 and W4, which recovery resumes);
  - `store.ts`: a copy's location (`gen-0001`, or `gen-NNNN/<attempt>`), its salvage (the longest prefix that verifies), and the `current.json` marker;
  - `ledger.ts`: `classifyAttempts` and `generationOfRecord`;
  - `protocol.ts`: destroy refuses while the waiver is unfinished, and recovery resumes it, re-applies a planned op a restore undid, and reports the waiver.
- **The database step:**
  - `keys ledger-waiver-audit --attempt <uuid> --detail <json>` writes `crypto.ledger.waived` and the attempt's `ledger_waiver` row in one transaction. If the row exists, it returns the first event's seq and writes nothing.
  - `keys ledger-bucket-read` lists and reads the bucket with the app's S3 identity, capped at 100,000 objects.
- **`ledger_waiver(attempt_id PK, audit_seq UNIQUE → platform_audit_event.seq)`:** expand only. The app role can't update, delete or truncate it.

**New entry types:**
- `established` (the attempt and its plan);
- `audited` (the attempt and the audit seq);
- `not_applied` (a planned roll-forward the database refused, with its reason).

A later generation's `genesis` also carries its `attempt` and the `transition` record (the reason, the time, the copies read and their heads, the statement).

**Decisions made while building.** The owner approved all seven on 2026-10-23.

1. **Every attempt is classified one way: established, undetermined or inert.**
   - **Established:** `established` is on every destination it still configures, and each reads.
   - **Inert:** no readable destination shows `established`, or a readable one lacks it (W1 or W2 stopped). It is never read, never completed and never evidence.
   - **Undetermined:** some destinations show `established`, every readable one has it, and the rest can't be read. It is never treated as inert, because it may be established on the others. It fails closed, like an established generation with a destination missing (A3-8).

   One classifier serves the generation of record, the waiver's numbering, its evidence and its refusal. The unit tests found why: with separate rules, a retry after an inert attempt became generation 3, and an inert attempt's copy counted as "readable", refusing the retry.
2. **A new generation's number is the highest non-inert generation found, plus one.** A retry after an inert attempt reuses the number, in a new attempt directory.
3. **The waiver finds destinations through the bucket too.** The bucket's chains name the old generation's destinations. With the primary lost, that is how the external drive is found. If that drive still reads, the waiver is refused in favour of `rebuild-destination` (BK16). A full, verifying copy given with `--from` is a copy of record in the same way, so it is refused too: rebuild from it instead. A damaged copy given with `--from` is evidence (its valid prefix), never a copy of record.
4. **Only this ledger's chains in the bucket count.** The bucket keeps every ledger it was ever sent, for 10 years, so it may hold an earlier one (after a re-init, say).
   - With a copy on disk, the bucket's other ledgers are reported, and left out of the plan.
   - With no copy on disk and more than one ledger in the bucket, the waiver is refused. Name a copy with `--from`.
   - Copies on disk from two ledgers are refused, as before.
5. **A fix to A2's bucket copy.**
   - **The problem:** it filed every entry under `gen-0001` and kept its progress per ledger id. A waived generation starts again at seq 1, so its entries would never have been copied.
   - **The fix:** entries now go under `gen-NNNN/<attempt>`, and progress is kept per location. Generation 1 keeps its bare ledger-id key in `.bucket-copied.json`, so nothing already recorded changes.
6. **The audit event records:** the ledger id, the generation, the reason, the statement, the copies read, the number of planned ops, and the attempt. It records ids and counts, never key material.
7. **`stack:smoke` prints the waiver line whether it passes or fails.** It prints nothing when the ledger is in generation 1, or can't be read from the smoke check (recovery reports that).

**What the marker does and doesn't detect.** `current.json` stops a deleted generation directory from letting an older generation step in. It can't detect every destination being replaced by a copy from before the waiver, with its marker. That is A2's existing limit (every destination swapped for its older self), unchanged.

**Tests.**

- **Unit, against the in-memory database model** (`waiver.spec.ts`, 29 cases):
  - every BK17 refusal. That includes a destination of record found through the bucket alone, and more than one ledger with no copy on disk;
  - the bootstrap, including W1 and W2 failing on one destination;
  - a row that is in no copy;
  - a pending op rolled forward, and refused and recorded as not applied;
  - A3-8's fail-closed cases;
  - the marker;
  - a planned op undone by a restore;
  - two established attempts;
  - a destruction after the waiver guaranteed again;
  - crash injection at each phase: W1 on one destination, W2 on some, before the audit, between ops, and between an op's transaction and its record;
  - conflicting evidence during resumption;
  - the bucket copy's location and progress, and the bucket's other ledgers.
- **Unit, `smoke.spec.ts`:** the notice, and no notice in generation 1 or with no ledger.
- **Integration (CI's disposable database, `test:ledger`):** after staged total loss, the waiver with the real `keys` CLI is stopped right after its audit event, then resumed by recovery. The test checks:
  - generation 2, with one `ledger_waiver` row and one `crypto.ledger.waived` event;
  - every `key_destruction` row is planned and has a result;
  - the app role is refused `DELETE` and `UPDATE` on `ledger_waiver`.

**Mutations caught (28 of 28):**
- **the refusals:** the phrase, the reason, the primary, a readable copy of record;
- **the bootstrap:** W1 or W2 failure ignored; inert attempts read; inert attempts kept as evidence; inert attempts counted as copies of record;
- **the audit:** written more than once;
- **the plan:** database rows ignored; a pending op forced; a refused roll-forward recorded as applied;
- **resumption:** not run by recovery; a recorded op run again; the waiver not reported by recovery or `stack:smoke`; destroy not blocked while the waiver is unfinished; a planned op undone by a restore left undone;
- **the generation of record:** an undetermined attempt accepted; a W2-stopped attempt accepted; markers not checked; two established attempts accepted;
- **the bucket:** discovery not using it; other ledgers mixed in; the copy's directory and progress not per location.

Three survived the first run. Each was a case no test isolated: W2 failing (only a crash was tested), a planned op undone by a restore, and two established attempts. Each now has its own test.

**Not in A3:** D7's "and the external drive when the backup destination is one" (PR B, with the backup destination); `stack:backup status`'s waiver line (PR B).

## Implementation notes (fix: the bucket copy)

**What was wrong.** Every recovery on the owner's stack reported `bucket copy (evidence only, not relied on) failed: exit 1: Access Denied.` (found 2026-10-23; the bucket stayed empty, and the ledger on disk was unaffected). There were three causes, each reproduced against SeaweedFS 4.48 before the fix:

1. **The identity.** `univarse-shred-ledger` had `Write:uv-shred-ledger` only. SeaweedFS checks a put's `ObjectLockMode` and retain-until headers as their own action, `PutObjectRetention`: a plain put was authorised, a COMPLIANCE put refused (403).
2. **The volumes.** The stack ran `-volume.max=16` with SeaweedFS's default growth of 7 volumes a collection. The filer's own metadata log (`/topics/.system/log`, collection `''`) is written about a minute after the first change and took 7; `uv-quarantine` took 7, `uv-clean` the 2 left, and `uv-shred-ledger` none. Even an authorised put found no writable volume.
3. **The deploy's order.** SeaweedFS loads `s3.json` only at start, and the deploy restarted it, when its files changed, only after recovery, so recovery's copy ran on the old identities.

**The fix.**

- The ledger identity holds `Write:uv-shred-ledger` and `PutObjectRetention:uv-shred-ledger`, and nothing that reads, lists, deletes, places a legal hold or bypasses governance (`render.ts`).
- SeaweedFS grows one volume a collection (`WEED_MASTER_VOLUME_GROWTH_COPY_1=1`, `master.toml`'s `volume_growth.copy_1` as an environment variable) up to 24 volumes (`-volume.max=24`, a 3 GB ceiling at 128 MB each). The owner's stack keeps its 16; the ledger's bucket takes the 17th.
- The deploy restarts SeaweedFS right after starting it when its files changed, before `buckets()` and the recovery, and records it, so it isn't restarted again at the end (`deploy.ts`).
- **`pnpm stack:bucket-check [--try-delete]`** (`bucket-check.ts`) is the owner's post-deploy check (and A2's still owed). It talks S3 through the edge (`https://files.stack.univarse.localhost`, resolved to 127.0.0.1, verified against the edge CA) as both identities in `secrets.json`, and prints PASS and FAIL lines only, never a key. It checks:
  - the app identity can list and read the bucket (A3-5's `ledger-bucket-read`);
  - the bucket holds this ledger's chain from its genesis, with no gap;
  - every entry on disk is in the bucket, byte for byte;
  - object lock is enabled;
  - every copied entry is retained in COMPLIANCE mode for 10 years from its write;
  - the ledger identity can't list or read its bucket, or list or write `uv-quarantine` or `uv-clean`;
  - with `--try-delete` only: the genesis's locked version survives a versioned delete by each identity.

**Decisions made while building.** The owner approved 1–13 on 2026-10-23, with decision 3 changed as written below.

1. **The growth count is set by environment variable,** not a mounted `master.toml`: SeaweedFS reads its TOML keys from `WEED_`-prefixed variables, verified on 4.48 (one volume per collection with it, seven without). There is nothing to render and no extra file in the conf volume.
2. **The maximum is 24.** An empty volume costs no measurable memory (natively: 119 MB with 7 volumes, 120 MB with 16), so the maximum bounds disk, not memory. 24 leaves the owner's stack 7 volumes of headroom after the ledger's, at 3 GB at most.
3. **`compose.spec`'s secret-literal scan skips an explicit list of known setting names,** and its detector is unchanged. `WEED_MASTER_VOLUME_GROWTH_COPY_1` is 32 characters with a digit, so the scan took it for a secret. The list (`KNOWN_SETTING_NAMES`) holds that name only, and each name is skipped only as a whole token. Two tests keep it honest:
   - a planted secret (generated hex, generated base64url, and one that contains a skipped name) is still caught;
   - a name no longer in the compose file fails the test, so stale entries are removed.
4. **The integration test (`bucket.int.ts`) runs its own container, not the stack.** It resolves the `seaweedfs` service with `docker compose config` and runs that image, user, entrypoint, environment, command and memory limit, with `cap_drop: ALL` and `no-new-privileges`, on a data volume of its own and throwaway keys. It is not the stack's network, read-only root or Caddy; those are not what the bugs depended on.
5. **The test carries its own control.** The owner's pre-fix settings are derived from this commit's (16 volumes, no growth variable, no `PutObjectRetention`), and the test asserts they differ in exactly those three settings, so a later change can't quietly make the control the fix.
6. **`SEAWEEDFS_BIN`:** on a machine with the Docker CLI but no daemon, the test runs a weed binary of the image's version (checked) instead. That is how it ran while this was built. CI runs the container.
7. **The bucket check reads the primary copy at its generation of record without the ledger lock.** It writes nothing to the ledger, so it doesn't take the lock; a destruction running at the same moment can show its newest entry as not yet copied (rerun).
8. **Its write probe** (`bucket-check/<uuid>` in each other bucket) writes only if the identity is wrong. The app identity then removes it, and the line is a FAIL.
9. **A refusal must be a 403.** Any other error is a FAIL, so a gateway that is down can't pass for one that refuses.
10. **Retention is checked from the object's own write time,** with a day's tolerance for the job's clock, not from now.
11. **`--try-delete` targets the genesis's version,** the oldest; if it fails, it has deleted real evidence. The copy on disk stays the authority, and the next copy rewrites nothing for it (its progress says it was copied).
12. **The check stops after its first line if the app identity can't list the bucket** (an unreachable edge or a wrong CA, say). Every later check reads through it, and would otherwise report an empty bucket that isn't one.
13. **`@aws-sdk/client-s3` becomes a dev dependency of `tools/stack`,** at the version the API already locks: the check runs on the host. The deploy's `BUCKETS` are exported so the test creates the buckets exactly as the deploy does.

**What the owner's redeploy does.** The new command and environment make compose recreate SeaweedFS at `up -d --wait seaweedfs`, which loads the new `s3.json` too; the deploy then restarts it once more, because `s3.json` changed. That is harmless (two starts) and happens only on this deploy.

**Tests.**

- **Unit, `render.spec.ts`:** the ledger identity's actions exactly, so an added action fails; exactly two identities.
- **Unit, `deploy.spec.ts`:**
  - `s3.json` changed: SeaweedFS restarts right after it starts, before the buckets and recovery, and only then;
  - `s3.json` unchanged: no early restart, and another service's change restarts only that one, at the end;
  - a failed restart stops the deploy before the buckets and recovery.
- **Unit, `bucket-check.spec.ts`** (14 cases, a fake S3 modelling the lock and each identity's permissions): every check's PASS and FAIL, the clock tolerance, a non-403 error, the probe removed, `--try-delete` only when asked, and no error message printed.
- **Integration, `bucket.int.ts`** (`test:bucket`, CI; 6 cases, about 90 s):
  - **before the fix:** the owner's 7/7/2 reproduced, with 0 free; the locked put refused (403); the plain put finding no volume (5xx); `copyToBucket` failing;
  - **the upgrade,** the same data on this commit's settings: `copyToBucket` writes 3 entries; the ledger's bucket grows by exactly one volume, from `volume.list` (17 of 24);
  - retention COMPLIANCE for 10 years, which the ledger identity can neither shorten nor switch to GOVERNANCE;
  - `bucketCheck` passing all 13 lines, `--try-delete` included;
  - a fresh stack: each bucket grows by exactly one volume.

**Rehearsed end to end, while this was built (not committed):** `pnpm stack:bucket-check` itself, through a TLS proxy on 127.0.0.1:443 standing in for Caddy, with a throwaway edge CA, in front of SeaweedFS 4.48 on this commit's settings, with a real ledger copy on disk and the real `copyToBucket`. Results:
- 11 PASS lines and exit 0, and with `--try-delete`, 13;
- an entry on disk not copied: one FAIL line, exit 1;
- the wrong CA: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, exit 1;
- no `secrets.json`: exit 1, naming the file;
- no key value anywhere in the output.

**Mutations caught (24 of 24):**
- **the deploy:** the restart moved back to the end; always restarted; not recorded (`markApplied`); not removed from the set;
- **the identity, in `render.spec`:** `PutObjectRetention` dropped; `Read` added;
- **against SeaweedFS:** `PutObjectRetention` dropped; the growth variable removed; the growth variable misspelled, so ignored (caught by the one-volume assertion with the maximum still at 24); the maximum back to 16;
- **the compose scan:** the name removed from `KNOWN_SETTING_NAMES` (the scan fails on the compose file); a name skipped as a substring, not a whole token; the base64 branch dropped;
- **the check:** the retention mode ignored; any error taken for a refusal; the probe left behind; no clock tolerance; the content not compared; gaps not computed; `--try-delete` always on; the version's survival not verified; the lock not checked; an error message printed; the checks continuing after the app identity can't list.

None survived.

**Measured: SeaweedFS's memory after the upgrade (17 volumes; limit 256 MiB).**

| Where | How | Value |
| --- | --- | --- |
| Native, while this was built | RSS | 178 MiB |
| CI, the stack's image under its limit | `docker stats`, and the cgroup's `memory.peak` (`[bucket.int]` line) | 136.8 MiB, peak 164 MiB (#99's run on `100aaa8`) |
| The owner's stack, after the redeploy | `docker stats --no-stream univarse-stack-seaweedfs-1` | 122.3 MiB, 47.8% of the limit (`d07d54e`, 2026-10-23) |

**Done on the owner's stack (2026-10-23).** The owner released `d07d54e` (`releases/2026-10-23-d07d54e.json`) and deployed it:
- the deploy restarted SeaweedFS before the buckets and the ledger's recovery ("its identities changed");
- neither its recovery nor a later `pnpm stack:keys recover` reported a failed bucket copy;
- `pnpm stack:bucket-check` printed 11 PASS lines and exited 0. The ledger's chain is in the bucket from its genesis, seq 1 to 1, with no gap. Every entry is retained in COMPLIANCE mode for 10 years. The ledger identity can't list or read its own bucket, or list or write the others. The app identity can list and read it.

That is also the post-deploy check owed since A2: the first real write, COMPLIANCE retention of 10 years, and the identities' permissions. `--try-delete` was not run.

## Plan (PR B: backups, the rehearsed restore and the shred drill), for approval

**Status:** **approved by the owner on 2026-10-24, all as written** (B-1 to B-17). The amendments to D3, D5 and D9 are made in the Decisions table. B-3's manifest question and B-7's transaction question are still to be answered while building, and come back to the owner.

### B-1. The split: two PRs, as the handoff proposes, with four moves

**Recommendation: B1 and B2, with these changes to the handoff's list.**

- **B1: the stack can be backed up.**
  - Vault on Raft, and its one-time migration (D4, BK5's first half);
  - WAL archiving and its shipping (D3);
  - D5's sealing, and `stack:backup keygen`;
  - `pnpm stack:backup`, writing a set with its manifest (D2, BK3);
  - **moved in:** pruning at the end of each backup (BK8's first sentence). BK3 says a backup "prunes at its end", and D6 says retention never depends on a separate step. A backup that doesn't prune would contradict both, even if only the owner runs it by hand;
  - **moved in:** the backup's ledger snapshot under the ledger lock (BK14's fourth case, owed since A2). It is part of writing a set;
  - **moved in:** D7's "the external drive is a ledger destination when the backup destination is one". The backup destination is chosen in B1, so the rule has to hold from the first backup, not from B2. That includes `ledger waive`'s requirement;
  - **moved in:** every new subcommand in the release images that B2 needs (B-14). Then B1's release is the only release PR B needs, and the owner's drill runs on it;
  - BK9's secrets checks for everything B1 writes or prints.
- **B2: the restore is rehearsed and the shred drill holds.**
  - `pnpm stack:restore-rehearsal` into the isolated stack (D9, D10, BK6), with BK4's PITR and BK5's second half proven there;
  - the shred drill and its control (D11, BK7);
  - the checkpoint comparison (D12);
  - `stack:backup status` with its waiver line, the deploy's 26-hour warning, and `stack:backup schedule` (D6, BK8's rest);
  - `pnpm stack:restore` (over the stack, documented, not rehearsed against live data, D9);
  - BK9 for what B2 writes or prints; BK10's full mutation list;
  - the docs (Affected docs, below) and the drill record.

**Why split at all:** B1 changes the running stack (Vault's storage, PostgreSQL's configuration, a new role) and needs a release and a one-time owner migration. That should be deployed and verified on its own before anything depends on it. B2 changes nothing in the running stack.

**Alternatives:**
- **One PR:** too large to review adversarially, and the Raft migration would land in the same deploy as untested restore code.
- **Three PRs (Raft alone first):** Raft alone is small, but the owner would do two releases and two deploys for it. Rejected unless the owner prefers to take the Vault migration on its own.

### B-2. WAL: archived into a staging volume, then sealed and shipped by the host

D3 says `archive_command` writes each segment "to the backup destination's WAL area". That can't satisfy D5. `archive_command` runs inside the PostgreSQL container, which has no way to seal: the image has no Node, and `openssl enc` has no AEAD mode. So:

- **`archive_command`** copies each segment into a new stack volume, `pg-wal-staging`. It refuses to overwrite (`test ! -f`), and `sync`s before returning 0. PostgreSQL's own documented pattern.
- **`archive_timeout = 300`** (5 minutes): a quiet database still closes a segment within 5 minutes of a write.
- **`pnpm stack:backup wal`** (the host) ships the segments:
  - it reads each staged segment through a one-shot container (no network, read-only volume, the pinned PostgreSQL image) as a stream;
  - it compresses it (gzip, `zlib`), seals it (D5), and writes it to `<destination>/wal/<timeline>/`;
  - each segment is made durable with A2's discipline: `fsync`, read back, and the sealed bytes' SHA-256 verified;
  - only then does it delete the staged segment.
- **When it runs:** every 15 minutes, by a second scheduled task (B-15), and at the start of every backup.
- **Amends D3's wording:** "to a staging volume, then sealed and shipped to the backup destination's WAL area by the host".

**Stated limits:**
- **RPO:** while the machine runs and the schedule is registered, at most about 20 minutes (5 + 15).
- **The failure domain:** a segment not yet shipped is inside the stack failure domain. Losing the stack loses up to that much.
- **Disk space:** if shipping stops, the staging volume grows. If it fills, `archive_command` fails and PostgreSQL keeps the WAL in `pg_wal`. Both are on the Docker VM's disk. `status` and every deploy report the oldest staged segment's age, and warn after 1 hour.

**Alternatives:**
- **A bind mount of the host destination** as the archive target: the WAL would sit in clear, contradicting D5. Docker Desktop's file sharing also gives no `fsync` guarantee we can verify. Rejected.
- **A sealing sidecar** built from the API image (it needs only the public key): it still needs that bind mount for the destination, with the same durability problem. It also adds a long-running service. Rejected.
- **`pg_receivewal` streaming:** it has the same sealing problem, and it holds a replication slot that fills the disk when it stops. Rejected.

### B-3. The base backup: `pg_basebackup` to stdout, sealed as it streams

- **The command:** `pg_basebackup -Ft -D - -X fetch -c fast --manifest-checksums=SHA256`. It runs in a one-shot container from the pinned PostgreSQL image, on the `db` network, over TLS `verify-full`.
- **Never in clear on disk:** its stdout is streamed to the host, sealed, and written. No unsealed copy touches the disk.
- **`-X fetch`:** each set restores on its own, without the archive. Then a lost WAL area costs PITR, not the set. `wal_keep_size = 512MB` keeps `fetch` from failing on a busy database.
- **The role:** a new replication role, `univarse_backup`. It has `REPLICATION` and nothing else: no database, no table, no `BYPASSRLS`.
  - It is created by the migrate job's bootstrap, so this is a migrate image change.
  - `pg_hba.conf` gains one line: `hostssl replication univarse_backup` from the `db` network, SCRAM.
  - Its password is a new secret, generated by the deploy's `upgradeSecrets` (A2-6), with names printed and values never.

**To verify while building:** whether `backup_manifest` is carried in the tar stream with `-D -` on PostgreSQL 18. If it isn't, the rehearsal checks the restored data with `pg_verifybackup` against a manifest written by a plain-format run instead.

### B-4. Vault on Raft, and a deploy that can't initialise over the old Vault

- **`stack.hcl`:**
  - `storage "raft"` on a new volume, `vault-raft` (`node_id = "vault"`);
  - `cluster_addr = "https://vault:8201"`, on the `app` network only, published nowhere.
- **The old volume, `vault-data`, is kept** (D4). It is removed from the service but not deleted. A later explicit owner command deletes it, once the migrated Vault is verified.
- **The guard, the important part:** today a deploy that finds Vault `uninitialised` initialises it. On B1's release, Vault would start on an empty Raft volume, and the deploy would create a **new** Vault with a new KEK. Every wrapped DEK would then be unreadable, with the data still in the old volume. So:
  - the deploy **refuses** when `vault-raft` is empty and `vault-data` holds a Vault;
  - its message names `pnpm stack:vault migrate-raft`;
  - a test covers it, and it is a BK10 mutation.
- **`pnpm stack:vault migrate-raft`** (the owner, once):
  1. stop Vault;
  2. run `vault operator migrate` in a one-shot container, with `vault-data` read-only and `vault-raft` writable (as built, it migrates from a scratch copy of `vault-data`, because the migration writes a lock into its source: B1 decision 13);
  3. start Vault on Raft. The owner unseals with the **same** unseal key: the migration keeps the barrier keyring;
  4. verify that every active DEK unwraps (the keys job's `verify-unwrap`, B-14). Only then is the migration recorded.

  If verification fails, `pnpm stack:vault migrate-raft --revert` puts the file storage back. `vault-data` was never written. (As built there is no `--revert`: nothing is recorded, the file storage was never written, and running the command again starts over. B1 decision 13.)
- **The snapshot's token:** a new policy, `univarse-backup`, with `read` on `sys/storage/raft/snapshot` only. Its token sits in `vault-init.json`, beside the app's, so the backup never uses the root token.

**Alternative:** have the backup use the root token. That is simpler, but a scheduled task would then hold root on Vault. Rejected.

**Stated:** Vault's audit log volume is not in a set, as approved in D2.

### B-5. Sealing: D5 as written, plus a passphrase on the private key

- **The format:** a file starts with a header:
  - magic `UVSEAL1`;
  - the recipient key's fingerprint (SHA-256 of the public key);
  - an ephemeral X25519 public key;
  - an HKDF salt;
  - the content key, wrapped under the ECDH-derived key (AES-256-GCM).

  Then come 64 KiB chunks, each AES-256-GCM under the content key. Each chunk's nonce is the chunk counter, and its AAD is the header's hash, the counter and a final-chunk flag. So truncation, reordering, splicing between files and header edits all fail.
- **Why a wrapped random key**, rather than a key derived straight from ECDH (equally secure): rotating the backup key re-wraps the headers without re-encrypting the sets.
- **The private key:** PKCS#8, encrypted with a passphrase.
  - The passphrase comes from `UNIVARSE_BACKUP_KEY_PASSPHRASE`, set by the owner as with `COSIGN_PASSWORD`. It is never prompted with echo and never printed.
  - **An amendment to D5,** which doesn't say. It is a second factor if the offline copy is found.
- **`keygen`:**
  - **It refuses a path** under `~/.univarse/stack`, the repository, any ledger destination, or the backup destination. That is BK9's mutation.
  - **It writes** `infra/backup/backup.pub` and prints the fingerprint only. The owner keeps two copies, as with the signing key.

### B-6. A set on disk: what is sealed, and the clear index

- **Layout:** `<destination>/sets/<setId>/` holds:
  - one sealed file per artifact: `postgres.tar.seal`, `vault.snap.seal`, `files.tar.seal`, `stack.tar.seal` and `ledger.tar.seal`;
  - `manifest.seal`;
  - `index.json`, last.
- **The sealed manifest holds everything D2 and BK3 name:**
  - versions, and every artifact's size and plaintext SHA-256;
  - the audit checkpoint and row counts (B-7);
  - the ledger snapshot's generation, seq and head (B-8);
  - the deployed digests, from the release record.
- **The clear `index.json`:**
  - the set id, its time, and complete: true;
  - the backup start WAL file and timeline;
  - each sealed file's name, size and SHA-256;
  - the key fingerprint.

  It holds no tenant name, no count, no secret.
- **Why a clear index:** the scheduled task must prune, and `status` must report, **without the private key**. They can also check every sealed file's hash.
- **Completeness:** the index is written last and is the set's completion marker. A set without it is incomplete and ignored, and is removed by a prune once it is a day old.
- **Durability:** every file is `fsync`ed and read back, as in A2's store.

**Alternative:** everything sealed, including what prune needs. The schedule would then need the private key, which D5 forbids. Rejected.

### B-7. The audit checkpoint and row counts, against what the rehearsal restores to

D10 asks that row counts and chain heads match the manifest. A physical backup has no single "moment" the host can read facts at, and the two databases can't share one transaction. So:

- **One `REPEATABLE READ` transaction per database**, run by the keys job after the base backup:
  - its first statement is `pg_create_restore_point('uv-<setId>-<db>')`;
  - it then reads the chain heads (the platform's, and each tenant's), and row counts per table and per tenant, through the existing tenant-scoped access. That means no `BYPASSRLS` role, invariant 1.
- **The rehearsal restores to the later of the two restore points** (`recovery_target_name`, inclusive). It then compares:
  - each chain verifies, and holds the checkpoint's `seq` with its hash exactly;
  - counts match exactly.
- **Stated window:** a commit that lands between the first database's transaction and the later restore point is in the restore but not in that database's counts. On the owner's quiet stack that window is a second or two. The drill note says to run the drill while nobody is using the app.
- **A mismatch fails the drill,** naming the table. It is never tolerated, and the owner reruns it.

**To resolve while building, and bring back:** whether `ShardRegistry` can give one transaction across tenants (switching the tenant context inside it). If it can't, the shard's counts become one transaction per tenant, and the window above widens. I'll measure that and bring it back as a decision, not decide it alone.

**Alternative:** pause the app during the facts. That is exact, but a backup would interrupt the stack every day. Rejected.

### B-8. The ledger in a set

- **Order and locks:** under the registry lock (the backup's own), then the ledger lock (D14's order).
- **Authority first:** the backup establishes the authoritative ledger read-only, with A2's routine, and refuses to take a set when it can't. A set taken under a broken ledger would capture a broken state silently.
- **What is copied:** the generation of record's files and every generation's `current.json` marker.
- **Recorded:** the snapshot's generation, seq and head, in the manifest.
- **The BK14 case:** a backup during a destruction waits, and its snapshot is a prefix of the live ledger.

### B-9. The backup destination, and D7's external-drive rule

- **The setting:** `~/.univarse/stack/backup.json`, written by `pnpm stack:backup destination <path>`. The default is `~/.univarse/backups/`, owner-only.
- **What counts as "an external drive":** a destination on a different device from the primary ledger (`stat().dev`; on Windows the volume serial, which Node reports as `dev`).
- **The rule:** when the destination is on a different device, a ledger destination on that same device must be configured. Until it is:
  - `stack:backup` refuses, naming `pnpm stack:keys ledger add-destination <drive>\univarse-ledger`;
  - `ledger waive` requires such a destination among its `--destination`s (D7, D8).

**Alternative:** a flag the owner sets ("this is external"). It is easy to forget, and the rule would fail open. Rejected.

### B-10. The isolated rehearsal stack

D9 says PostgreSQL, Vault and SeaweedFS only. The D10 checks also need the release's code: the keys job (unwrap, decrypt, chains, recovery) and the migrate image (`rls:check`). So, as an **amendment to D9's wording**:

- **The project:** `infra/stack/restore.compose.yml`, compose project `univarse-restore`, labelled. It runs on internal networks only, with no published port and no edge.
- **Long-running:** PostgreSQL, PgBouncer, Vault and SeaweedFS.
- **One-shot jobs:** from the release named in the set's manifest, by digest, verified with `images:verify` first. No API, worker or web.
- **Its env files** are rendered from the set's own `secrets.json`, with this project's hostnames, into a temporary owner-only directory that is removed afterwards.
- **No clear copy on the host:** a set is unsealed as a stream into the project's own volumes (`docker run -i … tar -x`). The one exception is the env files, which the stack writes owner-only today too.
- **Teardown:** in a `finally`, even on failure (BK6). The command removes only volumes carrying its label. A leftover project from a crashed run is found and removed at the start.
- **Memory:** about 1.1 GB more, by the limits. On the 8 GB machine the drill note says to stop the dev stack and dev ClamAV first. The real usage is measured and recorded in the drill.

### B-11. The rehearsal's recovery runs on a scratch copy of the ledger

D8 has every restore run recovery. In a rehearsal, recovery would append `reapplied` records to the **real** ledger for a database that is thrown away minutes later. That is false evidence, and it changes the thing BK6 says stays untouched. So:

- **Authority:** the rehearsal establishes authority read-only from the real destinations. It fails closed exactly as D8 does.
- **The scratch copy:** under the ledger lock, it copies them into a scratch directory, and recovery runs on that copy.
- **The check:** the real ledger's heads before and after are compared, and must be equal.
- **`pnpm stack:restore`,** the real one, uses the real ledger.

**Alternative:** let the rehearsal write to the real ledger. Rejected for the reason above.

### B-12. The shred drill

- **The drill tenant:** a new tenant per drill, `shred-drill-<yyyymmdd>`.
  - A `shred-drill` tenant destroyed once stays destroyed, so a second drill needs a fresh one.
  - Each drill leaves one permanent, accepted destruction in the real ledger, which is its evidence.
  - It is created by a new image subcommand (B-14). That command accepts only that slug pattern, and gives the tenant a data key and a few generated non-PII encrypted values.
- **The sequence on the owner's stack:**
  1. create the drill tenant;
  2. `pnpm stack:backup`;
  3. `pnpm stack:keys destroy shred-drill-<date>`, the real protocol;
  4. `pnpm stack:restore-rehearsal <that set>`.
- **In the rehearsal, before recovery (the control):** the drill tenant's values decrypt, and so do every other tenant's. That proves the set really held its keys. The control is shown, then torn down with the stack, which is D11's "removed".
- **After recovery:** the drill tenant fails to decrypt with its key destroyed, and every other tenant decrypts.
- **The mutation:** "the drill passes without the re-apply step" must turn the test red (BK10).

### B-13. Retention and pruning (in B1)

- **What is kept:** the 7 newest complete sets, plus the newest set of each of the 4 newest ISO weeks.
- **What is never deleted:**
  - the newest set;
  - any WAL a kept set needs: every segment from the oldest kept set's start WAL file, timeline-aware.
- **What else is deleted:** incomplete sets older than a day.
- **Shape:** a pure function, unit-tested at every boundary. The deletion runs under the registry lock and logs what it removed, by set id.

### B-14. Image changes, all in B1's release

- **The migrate image:**
  - the `univarse_backup` role;
  - `EXECUTE` on `pg_create_restore_point` for the keys job's role;
  - a `--check-only` mode (`rls:check` and the migration status, with no migration, seed or key creation), for the rehearsal.
- **The API image, as new `keys` subcommands:**
  - `backup-facts`: B-7;
  - `verify-unwrap`: every active DEK, the platform's and each tenant's;
  - `verify-decrypt`: a sample of each tenant's encrypted values, reported per tenant as `ok` or `key_destroyed`, never a value;
  - `verify-chains`: every chain, against a checkpoint;
  - `drill-tenant create`: B-12.

  Each prints JSON with ids and counts only.

**Why all in B1:** B2 then needs no release, so the owner releases once for all of PR B. If B2 finds that it needs another subcommand, that is a second release, and I'll say so before building it.

### B-15. The schedule (B2)

- **What `pnpm stack:backup schedule` registers,** with `schtasks /Create /XML`:
  - a daily backup, at a time the owner gives;
  - `stack:backup wal` every 15 minutes.
- **How they run:** both as the owner, "only when logged on". Docker Desktop needs the session anyway, and the other option stores the owner's Windows password.
- **The owner approves:** without `--apply`, the command prints the XML and changes nothing. A test checks exactly what it registers.
- **Other systems:** Windows only, stated. Elsewhere it prints the equivalent cron lines and registers nothing.

### B-16. What runs where

- **CI, as new steps beside `test:ledger` and `test:bucket`:**
  - sealing (unit);
  - prune (unit);
  - BK4's PITR, on a real PostgreSQL 18 container: a base backup, a row before the target time and one after, archive, restore to the time;
  - BK5: a file-storage Vault, `operator migrate` to Raft, every DEK still unwraps, and a snapshot restored into a second Vault unwraps them;
  - the deploy's refusal over an unmigrated Vault;
  - the drill's two halves, with the real built keys CLI against the disposable databases.
- **CI can't run the full rehearsal:** it needs a whole stack and a release. That runs on the owner's stack, and its record in `docs/ops/drills/` is BK6's and BK7's evidence. I won't claim a run that happened only in CI as the drill, or the reverse.

### B-17. The owner's steps, in order

**After B1 merges:**
1. Generate the backup key offline: `pnpm stack:backup keygen --out <your path>` with `UNIVARSE_BACKUP_KEY_PASSPHRASE` set. Commit `infra/backup/backup.pub` (a small PR).
2. Release (`pnpm images:release`) and deploy. The deploy refuses on the old Vault (B-4), as intended.
3. Run `pnpm stack:vault migrate-raft`, then `pnpm stack:vault unseal`, then deploy again.
4. Choose the destination (`pnpm stack:backup destination <path>`). If it's an external drive, add it as a ledger destination too.
5. Run `pnpm stack:backup`. I'll give the exact checks to read.

**After B2 merges:**
1. `pnpm stack:backup schedule --apply`.
2. The drill (B-12).
3. Commit the drill record.

**Spec amendments, made only once approved:** D3 (B-2), D5 (B-5's passphrase), D9 (B-10), and BK14's fourth case and D7's rule moving into B1 (B-1).

## Implementation notes (PR B1: Vault on Raft, WAL archiving, sealed sets)

Built as approved (B-1 to B-17, with B-1's moves into B1). B1 changes two release images:
- **migrate:** the backup role, and `--check-only`;
- **API:** five `keys` subcommands.

So a release follows it. It is the only release PR B needs, unless B2 finds otherwise.

**What runs where.**

- **The host** (`tools/stack/src/backup/`):
  - `seal.ts` (D5): the format, and the key files;
  - `keygen.ts`;
  - `set.ts`: a set's durable, sealed layout and its clear index;
  - `prune.ts`;
  - `wal.ts`: the shipper;
  - `pgbase.ts`: the base backup's arguments and start point;
  - `ledger-snapshot.ts` (B-8);
  - `external.ts`: D7's external-drive rule;
  - `backup.ts`, the order, and `real.ts`, the real steps;
  - `cli.ts`: `pnpm stack:backup`.
- **Also on the host:**
  - `vault-raft.ts` and `vault-raft-cli.ts`: B-4's states and the one-time migration;
  - the deploy's new `vaultStorage` step;
  - `volumes.ts`'s data volumes.
- **The stack:**
  - **PostgreSQL:** `archive_mode`, `archive_command` into `pg-wal-staging`, `archive_timeout = 300` and `wal_keep_size = 512MB`;
  - **the `pgbackup` job:** the pinned PostgreSQL image, on `db`, `verify-full`, as `univarse_backup`;
  - **Vault on Raft:** `vault-raft` replaces the mounted `vault-data`, which is kept;
  - **`pg_hba`:** replication for `univarse_backup` only.
- **The images:**
  - **migrate:** `univarse_backup` (LOGIN REPLICATION, nothing else) when given `ROLE_VERIFIER_BACKUP`, and `--check-only`;
  - **API:** `keys backup-facts`, `verify-unwrap`, `verify-decrypt`, `verify-chains [--checkpoint-stdin]` and `drill-tenant create` (`apps/api/src/cli/backup-checks.ts`), plus a read-only `sample` on each encrypted column.
- **A new secret:** the backup role's password and verifier, added to an existing `secrets.json` by the deploy (A2-6).
- **A new Vault policy and token:** `univarse-backup`, which reads `sys/storage/raft/snapshot` and nothing else.

**A set on disk** (B-6): `<destination>/sets/<setId>/` holds:
- `postgres.tar.seal`, `vault.snap.seal`, `files.tar.seal`, `stack.tar.seal` and `ledger.tar.seal`;
- `manifest.seal`: versions, deployed digests, the start LSN and WAL file, the facts (B-7) and the ledger snapshot's head;
- `index.json`: clear, written last, holding only file names, sizes and SHA-256s, the start WAL file, the timeline and the key's fingerprint.

WAL goes to `<destination>/wal/<timeline>/<name>.gz.seal`. Every file is written through a temporary name, `fsync`ed, read back and hashed, then renamed in.

**Decisions made while building (for approval).**

1. **The private key file is UniVarse's own format:** scrypt (N = 2^17, r = 8, p = 1) and AES-256-GCM over the PKCS#8 key, with the fingerprint as AAD. Node's encrypted PEM was rejected: it uses PBKDF2 with OpenSSL's 2048 iterations. The passphrase must be at least 16 characters, from `UNIVARSE_BACKUP_KEY_PASSPHRASE`.
2. **`keygen` writes the key file new** (exclusive create, 0600 where the OS has modes). It doesn't change the folder's permissions: offline media may have no ACLs. It refuses the stack directory, the repository, every ledger destination and the backup destination, resolved through links. It never replaces `backup.pub`, because that would be a key rotation.
3. **A chunk's AAD is the header's hash and the final flag.** The nonce is the chunk counter, so a counter in the AAD too was redundant. Mutation testing showed it as an equivalent mutant, so it was removed.
4. **The weeklies come from ISO weeks older than every daily's week.** B-13's wording counted the dailies' own week, which gives about 21–28 days, not D6's approved "about 35 days". The code follows D6.
5. **Less privilege than B-7 and B-14 said.** No `EXECUTE` on `pg_create_restore_point`: the keys job's role is the API's role too. Instead the platform transaction's first statement reads `pg_current_wal_insert_lsn()`, which any role may call, and the rehearsal restores with `recovery_target_lsn`. The precision is the same.
6. **B-3's question: the manifest is in the stream.** With `-D - -Ft`, `backup_manifest` travels inside the tar stream. That was seen on PostgreSQL 16 here and is checked on 18 in CI. The set's start WAL file comes from `pg_basebackup -v`'s "start point" line, not from parsing the tar.
7. **`archive_command`** is spelled with `/wal-staging/%f` paths and no shell variable, so there is no `$` for compose to escape. It treats a segment already staged with the same bytes as archived, and fails on different bytes, so PostgreSQL keeps the segment.
8. **The data volumes:** `pg-wal-staging` (999:999) and `vault-raft` (100:1000) are external, created and owned by every deploy, and never emptied by it.
9. **The backup role is optional in the bootstrap** (`ROLE_VERIFIER_BACKUP`), so `pnpm db:setup` is unchanged.
10. **B-4's risk was smaller than the plan said:** `initialise()` already refused to create a second Vault while `vault-init.json` exists. The guard gives a clear refusal instead of a confusing one.
11. **B-4 has a fifth state, "unverified":** Raft data and file data with no marker, a migration stopped part-way. It is refused too. A retry starts over from the untouched file storage, comparing with the first attempt's saved "before" (`vault-raft.pending.json`: the KEK's shape and a probe's ciphertext, neither secret). It never reads "before" from a half-copied Raft.
12. **`migrate-raft` takes the record being deployed.** It verifies the record as the deploy does, with the registry lock held and the registry started. Then it checks, in order:
    - the KEK's metadata is identical;
    - a probe encrypted with the app token before the migration decrypts with it after;
    - that release's `keys verify-unwrap` unwraps every data key.

    Only then is the marker written.
13. **No `--revert` command.** The file storage is never written. `vault operator migrate` writes a lock key into its *source* storage, so it migrates from a copy in a scratch volume, removed afterwards; the file storage itself is only ever mounted read-only, and CI checks it by digest. Going back is deploying the previous release from its own commit, whose compose still uses file storage. docs/10 says so.
14. **B-7's open question, now answered, for your decision.** `ShardRegistry` gives one transaction per tenant, at READ COMMITTED, with no way to switch tenants inside one. A raw `set_config` would do it, but it bypasses `ShardRegistry`, which invariant 1 forbids. So:
    - each tenant's facts are one single-statement transaction, after the platform's;
    - **the window:** a write between the platform's WAL position and a tenant's statement shows in that tenant's counts but not in the restore;
    - a mismatch fails B2's drill, naming the table. The drill measures it on the owner's stack.
15. **Row counts are computed in PostgreSQL** (`query_to_xml` with `format('%I')`), over the tables the role may select. The app interpolates no identifier, and RLS scopes every tenant's count. The tables come from `pg_class`, and the privilege check uses each table's OID. CI's first run found why: a name-based check over `information_schema` can be evaluated before the schema filter, and it then tried to resolve `public.pg_statistic`.
16. **The drill tenant** (`shred-drill-YYYYMMDD`): SUSPENDED, no domain, no product, a data key, and three outbox rows already `DEAD` holding encrypted random bytes. The relay never picks up a `DEAD` row. It is audited on both chains.
17. **The destination's permissions:** the default is made owner-only. A path the owner chooses keeps its own permissions; the sets are sealed either way.
18. **`stack:backup wal` while the registry lock is held** (a deploy, a release or a backup): it ships nothing, exits 0 and says so. The next run ships it, and B2's `status` reports the staged age.

**Evidence.**

- **Unit** (`tools/stack`, 88 cases in `src/backup/`, plus `vault-raft.spec.ts`, `deploy.spec.ts`, `render.spec.ts`, `secrets.spec.ts`, `volumes.spec.ts`, and `waiver.spec.ts`'s D7 case):
  - **sealing:** sizes at every chunk boundary; truncation (at a boundary and inside a chunk), reordering, splicing, an edited header, a wrong key, trailing bytes; uneven stream pieces;
  - **the key files:** passphrase failures, no key material in the file;
  - **keygen:** every refused location, links included;
  - **a set:** `fsync` counts, a lying read-back, a failing source, the incomplete set, a malformed index;
  - **pruning:** the ISO-week boundaries, 60 days of dailies, dailies spanning two weeks, the newest set kept, incomplete sets, WAL across timelines;
  - **WAL:** the container's real `grep` and `tar` pipeline run locally against a directory; nothing removed on any failure;
  - **the base backup:** the LSN-to-file arithmetic;
  - **the ledger snapshot:** refused without authority, or when the file read differs from the verified chain;
  - **the backup's order and locks,** its refusals and stops, and BK14's fourth case with the real ledger lock;
  - **B-4's five states,** the migration's order, each failed check, and the retry;
  - **the backup policy and token;**
  - **the deploy's refusal,** before Vault starts;
  - **`backup.env`'s exact contents** and the secret's reach; the upgrade of an existing `secrets.json`.
- **Unit** (`apps/migrate`, `apps/api`):
  - **the migrate job:** `--check-only` runs only the status checks and `rls:check`, and the backup verifier is optional;
  - **the writer-bound guard** admits the drill's encryption (rule A);
  - **the decrypt verdict.**
- **Integration, CI:**
  - `apps/api`'s `backup-checks.int.spec.ts`: the drill tenant; `backup-facts` with RLS-scoped counts against another tenant; `verify-chains` with a checkpoint and a tampered head; `verify-unwrap` and `verify-decrypt` before and after the drill's destruction, the other tenant still decrypting;
  - `tools/stack test:backup` (a new CI step): Vault's migration with the pinned image on volumes of its own (every wrapped key unwraps, the file storage's digest unchanged, the backup token's snapshot and its refusals), and PostgreSQL 18's `archive_command` and `pg_basebackup` stream from the compose file's own settings.
- **Proven by hand here, not committed:**
  - **Vault 2.1.1,** the same version's binary, checksum verified:
    - the migration with the source read-only, the same unseal key, identical KEK metadata, and the probe decrypting with the app token;
    - the backup token's snapshot to `/dev/stdout`, and its 403s;
    - a restore into a fresh Raft Vault decrypting the probe;
    - `cluster_addr` need not resolve during the migration.
  - **PostgreSQL 16:** `archive_command`'s three cases. Then, end to end through `takeBackup` and `shipWal`:
    - a sealed set, then unsealed;
    - `pg_verifybackup` "backup successfully verified" against the manifest from the stream;
    - restored with `recovery_target_lsn`: the row written before the target present, the row after it absent.

**Mutations: 60 killed.**
- **sealing:** the final flag, the header hash, the counter in the nonce, unsealing's counter, the fingerprint check, the final-chunk boundary;
- **keygen:** the path check, overwriting, links not resolved;
- **a set and pruning:**
  - pruning: the newest set deleted, the weeklies counted in the dailies' weeks, incomplete sets deleted at once, a kept set's WAL deleted, WAL deleted with no complete set, WAL kept from the newest set, five weeklies, the ISO week's Thursday rule;
  - durability: no read-back (artifact, index), no `fsync`, the index hash not compared, a partial file left behind, any index accepted, another set's index accepted;
- **WAL and volumes:** the staging volume emptied, staged files never removed, an existing file overwritten, the network allowed, the staging volume not ensured;
- **the role and its environment:** BYPASSRLS, the password's shape unchecked, the role created without its verifier, TLS not verified, replication for every role, the secret not added on upgrade;
- **Vault:**
  - the deploy and its states: the deploy ignoring the state, a half-migrated Raft accepted, an unmigrated store taken for a fresh one, the volumes checked as root with no capabilities;
  - the migration: the KEK not compared, the probe's content not compared, an unwrap failure ignored, the file storage writable, a retry reading "before" from Raft, "before" read from Raft storage, the migration's success not confirmed, the backup token recreated;
- **the backup:**
  - its locks: the ledger lock not taken, the registry lock kept;
  - its refusals: the external rule ignored, an unreadable ledger ignored;
  - no pruning;
- **the rule, the snapshot and the checks:**
  - the external-drive rule: any destination accepted, an unreadable destination passing, `waive` ignoring the rule;
  - the ledger snapshot: taken without authority, dot-files copied, the copied file not checked;
  - the decrypt verdict: a partial destruction reported as destroyed, no samples reported as ok.

Eight survived the first run:
- one was the equivalent mutant (decision 3), and its redundant code was removed;
- seven were cases no test isolated, and each now has its own: `wx` under a race, the index's read-back, a malformed index, `fillVolumes` ensuring the staging volume, the upgraded secret, the migration's confirmation line, and the copied ledger file against the verified chain.

**Found in CI (the first runs on #103):**
- `backup-facts`' count query resolved `public.pg_statistic` (decision 15 now says why it reads `pg_class` by OID).
- `vault operator migrate` refused a read-only source: it writes a migration lock there. That was reproduced here with the 2.1.1 binary as a non-root user ("error setting migration lock: permission denied"). The migration now reads a scratch copy. That was also proven here: success, with the original byte-identical.
- Three test-only problems:
  - the Vault test's configs weren't readable by the vault user;
  - the PostgreSQL test checked readiness against the image's temporary setup server;
  - its wait stopped at a segment's `.part` copy, which merely contains the segment's name.
- On `9184ab0`, the Vault migration passed in CI against the pinned image: every wrapped key unwrapped, the KEK was identical, the file storage's digest was unchanged, and the backup token snapshotted and was refused everything else.

**Found on the owner's machine (2026-10-24, step 6):** `pnpm stack:vault migrate-raft` exited 13 ("unsettled top-level await") before doing anything. `vault.ts` was both the CLI's entry point and a module the migration imports, and its top-level `await import('./vault-raft-cli.js')` waited on a module that waited on `vault.ts`. The CLI now lives in `vault-cli.ts`, which nothing imports. `entrypoints.spec.ts` runs every `pnpm stack:*` entry point as a real process, through its usage path, so a deadlocked import graph fails a test. Unit tests that import the functions directly could not see it.

**Found on the owner's machine (2026-10-24, step 6, second run):** the migration itself succeeded: the KEK was identical and the probe decrypted. Then `keys verify-unwrap` failed with nothing on stdout, so nothing was recorded, and the file storage was left as it was. The cause was step 5. Its deploy was refused at the Raft guard, but before that `prepare(false)` had rewritten keys.env and api.env with a blank `VAULT_TOKEN`, because the token was read only at the deploy's Vault step. The API's config refuses a token shorter than 8 characters, so the keys job failed at startup, and only stderr said why, which was dropped. Four changes:
- `envTokens` now puts vault-init.json's token in the env files whenever the file exists. A deploy that stops early no longer blanks a working token, which would also have stopped the API at its next restart.
- `migrate-raft` rewrites the env files before it runs the keys job.
- A failed job's stderr tail and its exit status are reported. The API's errors name settings, never values.
- Each progress line now prints once. Before, they printed as they came and again in the result.

`vault.spec.ts` and `vault-raft-cli.spec.ts` cover these. 10 mutations, all killed. The env-file rewrite inside `migrate-raft` needs Docker, so the owner's rerun is its check.

**Found on the owner's machine (2026-10-24, the first `pnpm stack:backup`):** the set completed (exit 0), but every line printed twice, the same fault as `migrate-raft`. Both CLIs now use `print.ts`'s `printer`, which prints each line as it comes and leaves only the outcome to print at the end. Sizes printed as "0.0 MB" for the Vault snapshot and the small tars, which reads like an empty artifact. They now print in B, KB or MB (`size`). Covered by `print.spec.ts`, `backup/size.spec.ts` and an assertion in `backup.spec.ts`; 8 mutations, all killed.

**The owner's run (2026-10-24, release `2026-10-24-00baee7`):**
- **The backup key:** generated offline. Its public key was committed by the owner (`baac586`), and merged with #104. Fingerprint `sha256:90c83219d8d23b1598dd2b867ebb836ef158b3c47991e99d9ab0c66a2571d84e`.
- **The first deploy** refused on the file-storage Vault, as intended.
- **`migrate-raft`,** after the two fixes above: the KEK at version 1 was identical, the probe decrypted with the app token, and `keys verify-unwrap` reported 3 of 3 data keys. The migration was recorded in `vault-raft.json`. `univarse-stack_vault-data` is kept, untouched.
- **The deploy** then passed.
- **The first set,** `20261024T161305Z-e2bd`, took 16 s and exited 0.
  - 4 WAL segments were shipped first, through `000000010000000000000005`.
  - `postgres.tar` was 58.3 MB. The other four artifacts, then printed as "0.0 MB", are small (the fix above).
  - 6 sealed files: 5 artifacts and the manifest.
  - The ledger is at seq 2, and the set needs WAL from `000000010000000000000006`.
  - Pruning then removed the 4 shipped segments, which no kept set needs.
- **Not yet rehearsed:** no restore has been tried; that is B2.
- **`--commit` takes the full 40-character SHA.** A short one is refused as a different commit. That is correct, but the owner's first try used a short one.

**Found in the final review:** `vaultStorage` checked the volumes as root with every capability dropped. Root without `CAP_DAC_OVERRIDE` can't search the vault user's 0700 directories, so a migrated stack would have read as unmigrated. It now checks as the vault user, with a test and a mutation. CI's `test:backup` exercises the real case.

**Not run here:** the API's and stack's integration suites (no Docker daemon or Vault in this environment; CI runs them), and two existing `tools/stack` unit files that need a Docker daemon (`audit-failclosed.spec.ts`, `certs.spec.ts`), unchanged by B1.

**The owner's steps after B1 merges** (B-17). All done on 2026-10-24; "The owner's run" below has the results.
1. **Generate the backup key.** Set `UNIVARSE_BACKUP_KEY_PASSPHRASE`, run `pnpm stack:backup keygen --out <offline path>`, keep a second copy, and commit `infra/backup/backup.pub` (a small PR).
2. **Release and deploy.** Run `pnpm images:release`, then `pnpm stack:deploy releases/<record>.json`. It refuses on the old Vault, as intended.
3. **Migrate Vault.** Run `pnpm stack:vault migrate-raft releases/<record>.json` (it unseals with the existing key), then deploy again.
4. **Choose the destination,** optionally: `pnpm stack:backup destination <path>`. For an external drive, first run `pnpm stack:keys ledger add-destination <a folder on it>`.
5. **Take the first set:** `pnpm stack:backup`.

**Not in B1 (B2):**
- `stack:restore-rehearsal` and `stack:restore`;
- the drill and its record;
- `stack:backup status` and the deploy's 26-hour and staged-WAL warnings;
- `stack:backup schedule`;
- BK4's PITR test in CI.

## Plan (PR B2: the rehearsed restore, the shred drill, status and the schedule), for approval

**Status:** **approved by the owner on 2026-10-25, all as written** (B2-1 to B2-17). One amendment, made while building B2a, is marked in B2-4. The owner also confirmed that the ledger's second destination is on the external drive. B-1 to B-17 (approved 2026-10-24) still apply. This section fills in how B2 builds them, and the decisions they left open.

**For the owner's decision**, in order of weight. Each is explained below.
1. **Split B2 in two (B2-1).** B2a is `status`, the deploy's warnings and the schedule: small, and it gets daily backups running now. B2b is the restore, the rehearsal and the drill.
2. **One command for the drill (B2-11):** `pnpm stack:drill` runs B-12's four steps in order and writes the record.
3. **Files go back through SeaweedFS's filer,** from a one-shot container on the rehearsal's own network, so no port is published (B2-8).
4. **`pnpm stack:restore`, the real one, keeps what it replaces (B2-12).** It copies the data volumes and the stack directory aside before restoring, and asks for a confirmation phrase.
5. **The scheduled tasks (B2-4):** run from this checkout with node's and pnpm's absolute paths, log to `~/.univarse/stack/logs/`, at a daily time the owner gives.
6. **The rehearsal waits for the WAL it needs (B2-7):** up to 6 minutes, shipping as it goes, then refuses with the reason.
7. **`--to <time>` (B2-6):** row counts are compared only at the set's own target. A later time can't match them.

**No release is expected.** Every check B2 runs already exists in B1's images: `migrate --check-only`, and the keys job's `backup-facts`, `verify-unwrap`, `verify-decrypt`, `verify-chains`, `drill-tenant create`, `evidence` and `reapply`. B2 changes host tools and adds a compose file. If building shows it needs a new image subcommand, that means a second release, and I'll say so before building it.

### B2-1. Two PRs: B2a, then B2b

- **B2a: running backups unattended** (D6, BK8's rest):
  - `pnpm stack:backup status` (B2-2);
  - the deploy's warnings (B2-3);
  - `pnpm stack:backup schedule [--apply | --remove]` (B2-4).
- **B2b: the restore is rehearsed** (D9 to D11, BK4 to BK7):
  - the restore engine (B2-5 to B2-10);
  - `pnpm stack:restore-rehearsal`, `pnpm stack:drill` and `pnpm stack:restore`;
  - the CI tests (B2-13), the docs and the drill record.

**Why:** backups now run only when the owner remembers, and each day without one widens the RPO. B2a is a day's work and reviews easily. B2b is the largest piece of PR B and deserves its own adversarial review.

**Alternative:** one B2 PR, as B-1 planned. It's simpler to track, but the schedule waits for the rehearsal. Rejected unless the owner prefers one PR.

### B2-2. `pnpm stack:backup status` (B2a)

It reads only what needs no private key: the clear `index.json` files, the WAL area's file names, the staging volume's listing, and the ledger. It prints:
- **the newest complete set:** its id and age, or "no set";
- **the actual erasure boundary** (D6): the age of the oldest retained complete set, and the number of sets retained;
- **incomplete sets**, by id (a prune removes them once they are a day old);
- **WAL:** the newest shipped segment and its age, and the oldest *staged* segment's age (from the staging volume, through the same read-only tool container the shipper uses);
- **the schedule:** whether both tasks are registered (`schtasks /Query`), and their last result;
- **the destination,** and whether D7's external-drive rule holds;
- **the waiver line,** "no-resurrection guarantee waived since <time>", when the ledger's generation came from a waiver (BK17).

**Warnings** are lines marked `WARN`:
- the newest set is over 26 hours old, or there is none;
- a staged segment is over 1 hour old (B-2's stated limit);
- the schedule isn't registered;
- the external rule doesn't hold.

**The exit code:** 0 when everything could be read, warnings or not. 1 only when something couldn't be read. **Alternative:** exit 1 on any warning, so a script could gate on it. Nothing gates on it today, and a failing `status` reads like a broken one. Rejected.

### B2-3. The deploy's warnings (B2a)

At the end of every deploy, beside the D8 lines, the deploy prints `status`'s newest-set and staged-WAL warnings. They **never block** (D6 says "warns"). A destination that can't be read is a warning too, not a failure: the deploy's job is the stack, and a missing external drive must not stop it.

### B2-4. The schedule (B2a)

B-15, made concrete. `pnpm stack:backup schedule --at HH:MM` prints two task definitions as XML, and changes nothing. With `--apply`, it registers them with `schtasks /Create /XML`. `--remove` deletes both.
- **`UniVarse backup`:** daily at `--at`.
- **`UniVarse backup WAL`:** every 15 minutes, all day.
- **Both:**
  - **as the owner, only when logged on** (B-15);
  - **`StartWhenAvailable`:** a run missed while the machine slept runs at the next wake. Neither task wakes the machine;
  - **at most one at a time** (`IgnoreNew`), with a 2-hour limit.
- **The command each runs:** node's and pnpm's absolute paths, recorded when the schedule is made, run in this checkout (`node <pnpm.cjs> --dir <repo> stack:backup`). The task then doesn't depend on Task Scheduler's PATH.
- **Logs:** each run appends what it prints to `~/.univarse/stack/logs/backup-YYYY-MM-DD.log`, owner-only. Nothing printed is secret (BK9's scan covers it). A log over 30 days old is removed by the next run.
- **Contention:** a scheduled backup that finds the registry lock held (a deploy or a release) **waits for it**, checking every minute for up to an hour. Only then does it fail, and the failure is logged. The WAL task already ships nothing and exits 0 then (B1 decision 18).
  - **Amended while building (2026-10-25), approved by the owner on 2026-10-25.** The plan had Task Scheduler's `RestartOnFailure` retry a failed run. Windows applies that setting only when a task fails to *start*, not when it exits non-zero, so it would never have retried. The wait is the backup's own, and unit-tested.
- **Stated:**
  - **the tasks run whatever this checkout holds.** A branch checked out at 03:00 is what runs. The set records the tools' commit (`versions.tools`);
  - **so a scheduled run warns when the checkout isn't a clean `main`** (added 2026-10-25, approved by the owner; built in B2b):
    - it still takes the backup, since an imperfect backup beats none;
    - it logs `WARN` with the branch and whether the tree is dirty;
    - `stack:backup status`, and with it the deploy's warnings, show the warning until a later run is clean. It names the branch, never file contents.

    The owner's rule keeps this checkout on a clean `main`, with all branch work in worktrees, so the warning catches a slip, not normal use;
  - **Windows only.** Elsewhere the command prints the equivalent crontab lines and registers nothing (B-15).
- **The test:** the exact XML for given inputs, and that nothing is registered without `--apply` (BK8).

**Alternatives:** running as SYSTEM, or "whether logged on or not". Docker Desktop runs in the owner's session, so the first can't reach it, and the second stores the owner's Windows password. Rejected (B-15).

### B2-5. The restore engine: one routine, two targets (B2b)

**The tokens of a restored set** ([spec 0023](0023-vault-app-token-renewal.md), built first). A restored Raft snapshot brings back each token with its old expiry, so either may be past its period, and Vault then revokes it after unseal. The restore therefore runs `configure()` against the restored Vault, with the restored root token. That re-issues a dead token (spec 0023 T4) and renders the restored stack's env files with it. B2b tests a set whose tokens have expired, using `configure`'s short test period.

`tools/stack/src/restore/` holds one routine with its steps injected, as the deploy's are (spec 0019 LS3). That way the order, the stops and the teardown are unit-tested without Docker. It runs against one of two targets:

| | `stack:restore-rehearsal` | `stack:restore` |
|---|---|---|
| Compose project | `univarse-restore` (`infra/stack/restore.compose.yml`), labelled | the stack's own, after `stack:down` |
| Volumes | `univarse-restore-*`, created, then removed | the stack's, with the old data copied aside first (B2-12) |
| Ledger | a scratch copy (B-11, B2-10) | the real ledger, under its lock |
| Afterwards | torn down in a `finally`, even on failure (BK6) | left for the owner to deploy the set's release |

### B2-6. The rehearsal, step by step

1. **Before anything is created:**
   - the private key opens with the passphrase. The key comes from `--key <path>` and the passphrase from `UNIVARSE_BACKUP_KEY_PASSPHRASE`, both never printed. A wrong passphrase stops it here;
   - the set is complete, and every sealed file's SHA-256 matches its `index.json`;
   - a leftover `univarse-restore` project from a crashed run is found by its label and removed.
2. **The release:** the manifest's deployed digests name a release record in `releases/`. It is verified as the deploy verifies one, with the record's own commit, under the registry lock and with the registry started. A record or image that's no longer there stops it, naming `images:prune` as the likely cause.
3. **The manifest,** unsealed into memory: the facts (B-7), the ledger head, and each artifact's plaintext SHA-256. Every artifact unsealed later is hashed as it streams, and any mismatch stops the rehearsal.
4. **The configuration:** the set's `stack.tar` gives `secrets.json`, `vault-init.json` and `certs/`. The env files and rendered configs (`pg_hba.conf`, `pgbouncer.ini`, `userlist.txt`, `s3.json`) are rendered from them, with the stack's own service names, into a temporary owner-only directory, then copied into the project's labelled config volumes. The certificates are the set's own, so their names (`postgres`, `pgbouncer`, `vault`) hold inside the project's networks.
5. **PostgreSQL:**
   - `postgres.tar` is unsealed as a stream straight into the data volume (`docker run -i … tar -x`, as uid 999);
   - the WAL from the set's start file through the target's file is unsealed and gunzipped as a stream into a second labelled volume;
   - PostgreSQL starts with `restore_command = cp /wal-restore/%f %p`, the target (below), `recovery_target_action = promote` and **`archive_mode = off`**, so a restored cluster never archives anywhere;
   - it must end recovery at the target: `pg_last_wal_replay_lsn()` must reach it, or the rehearsal stops.
   - **The target:** by default, the facts' WAL position (`recovery_target_lsn`, B1 decision 5), so the counts and the checkpoint compare exactly. With `--to <ISO time>`, `recovery_target_time`:
     - **refused** before the set's creation (use an earlier set);
     - **a time past the newest shipped WAL** makes PostgreSQL end recovery short of it, which it reports itself. The rehearsal stops with "target not reached", naming the newest segment it had. WAL file names carry no time, so this can't be checked before starting;
     - **the counts** are then reported, not compared, since a later time holds more rows;
     - **the checkpoint** must still hold: the chains are append-only, so the checkpoint's `seq` keeps its hash.
6. **Vault:**
   - started on an empty labelled Raft volume, initialised with throwaway keys (held in memory, never written) and unsealed with them;
   - `operator raft snapshot restore -force` from the unsealed stream;
   - then unsealed with the set's own unseal key, from `vault-init.json`. This is BK5's second half on real data. B1 proved the mechanics by hand.
7. **SeaweedFS:** started, with its buckets created as the deploy creates them. The files are restored as B2-8 describes.
8. **PgBouncer:** started.
9. **The checks before recovery,** each a one-shot job from the verified release, in the project:
   - `migrate --check-only`: the migration status, and `rls:check`;
   - `keys verify-chains`, with the manifest's checkpoint;
   - `keys backup-facts`, compared with the manifest's counts (at the default target only);
   - `keys verify-unwrap`;
   - `keys verify-decrypt`, the D11 **control**. Every tenant whose keys the set holds decrypts, the drill tenant's included when the set has one. A tenant destroyed *before* the set was taken (an earlier drill's, say) is already `key_destroyed` in the set, before and after recovery. A tenant with no encrypted values reports `empty`, which is shown and not a failure, except for the drill tenant, which must have values.
10. **Recovery** (D8) on the scratch ledger (B2-10), through the project's keys job.
11. **The checks after recovery:**
    - `keys verify-decrypt`: every tenant with an accepted destruction is `key_destroyed`, and every other is `ok` (or `empty`, as above);
    - `keys verify-unwrap`: every key not destroyed unwraps;
    - `keys verify-chains`: recovery's own audit events keep the chains verifying.
12. **The real ledger's heads,** read before step 1 and again now, must be equal (B-11).
13. **The record** (B2-11), then the **teardown**: `compose down -v` for the labelled project only, the temporary directory and the scratch ledger removed, in a `finally`.

**What is never in clear on the host's disk:** artifact data and WAL. They go from the sealed files, through host memory, into the project's Docker volumes. The temporary directory holds the rendered env and config files, owner-only, as `~/.univarse/stack` does, and is removed afterwards.

### B2-7. The WAL a target needs

- **Which:** every segment from the set's start file through the target's, on the set's timeline, plus any `.history` file that timeline needs. The shipper already ships those (B1).
- **First, it ships:** the rehearsal ships staged WAL itself (it holds the registry lock, so it calls the shipper directly).
- **Then it waits:** for the default target, the segment holding the facts' position is often still open, because `archive_timeout` is 5 minutes. So the rehearsal ships every 30 s for up to 6 minutes, saying what it waits for. If it is still missing, it stops: "the segment holding this set's target hasn't been archived yet: run this again in a few minutes."
- **A gap** (a segment missing between the start and the target, which isn't the newest) stops it at once, naming the segment. Waiting can't fill it.

**Alternative:** make the backup force a WAL switch after its facts (`pg_switch_wal()`), so the segment closes at once. That needs `EXECUTE` on a superuser function for an app role, the kind of grant B1 decision 5 avoided, and it's a migrate image change, so a release. Rejected; waiting costs the drill a few minutes.

### B2-8. Files: back through the filer, checked one by one

D10 asks that every restored file's SHA-256 matches. The manifest holds `files.tar`'s hash, not each file's. So:
- `files.tar` is unsealed as a stream, and the host hashes each entry as it passes;
- the stream goes into a one-shot container from the pinned SeaweedFS image, on the project's own network. That container writes each entry into the restored bucket through the filer (`/buckets/uv-clean/<key>`);
- each object is then read back over the S3 path, hashed inside the container, and compared with the host's hash. Only hashes and keys come back, never content.

**Alternative:** a temporary loopback tunnel to the project's S3 port (B4's pattern), with the host's S3 client. It reuses tested code, but it publishes a port, which D9 rules out. Rejected.

**To verify while building, and bring back if it fails:** that an object written through the filer is readable through SeaweedFS 4.48's S3 API with its key unchanged. If it isn't, the fallback is the tunnel above. That's an owner decision, since it bends D9.

### B2-9. Counts, chains and the window

- **Counts compare exactly at the default target.** A mismatch fails the rehearsal, naming the table (B-7). B1 decision 14's window applies, since each tenant's counts are their own transaction. The drill measures it.
- **The chains** are verified twice: against the checkpoint before recovery, and whole after it.
- **The note to the owner:** run the drill while nobody is using the app.

### B2-10. The scratch ledger (B-11, made concrete)

Recovery finds every destination by the path written in the ledger itself, so a plain copy would lead it back to the real destinations. So:
- under the ledger lock, briefly, every configured destination's copy is read and verified (authority, D8, read-only), then copied into `scratch/<destination id>/`. Then the lock is released;
- recovery runs with a `LedgerFs` that maps each real destination's path to its scratch copy. Windows paths are compared without case, as `canonical()` does. Nothing else in the protocol changes;
- **the bucket copy is off in a rehearsal** (D7's evidence copy, never relied on): the restored SeaweedFS has no ledger bucket, since D2 leaves it out;
- **the check** (B2-6 step 12): the real heads are unchanged.

**Tests:** a scratch run against real files, where recovery appends `reapplied` in the scratch copies and the real ones stay byte-identical. And the mutation "a path not remapped", which must turn a test red.

### B2-11. The drill: `pnpm stack:drill --key <path>`

B-12's sequence, as one command that stops at the first failure:
1. `keys drill-tenant create shred-drill-<YYYYMMDD>`. A drill tenant from today already existing stops it;
2. `pnpm stack:backup`;
3. `pnpm stack:keys destroy shred-drill-<YYYYMMDD>`: the real protocol, with every ledger destination needed;
4. the rehearsal of that set, with D11's expectations made explicit:
   - **before recovery (the control):** the drill tenant is `ok`. If it doesn't decrypt, the set never held its keys, and the drill fails. Every other tenant is as B2-6 step 9 says;
   - **after recovery:** the drill tenant is `key_destroyed`, and every other tenant is exactly as the control found it.

**What it leaves, by design (B-12):** a suspended tenant with destroyed keys, and one accepted destruction in the ledger. That is its evidence.

**The record:** `docs/ops/drills/YYYY-MM-DD-restore-and-shred.md`, written by the command for the owner to commit. It holds:
- the set id, the release, and the target position or time;
- each D10 check, pass or fail, with counts;
- **the timings:**
  - RTO, from the first unseal to the last check;
  - the RPO reached: how old the newest shipped WAL segment was when the rehearsal began, by its file's time at the destination. It's the data a restore at that moment would have lost;
- the peak memory of the project's containers, sampled with `docker stats` every 5 s.

It holds slugs, ids, counts, hashes and times only. BK9's scan runs over it before it is written. `stack:restore-rehearsal` alone writes the same record without the drill's lines.

**Alternative:** four separate commands, as B-12 lists. They're more transparent, but the order matters (the backup must come between the tenant and the destruction), and it's easy to get wrong by hand. Rejected; the single command prints each step as it goes.

### B2-12. `pnpm stack:restore <set> [--to <time>]`, the real one

The same routine against the stack itself, for a real disaster. It is never run in a drill (D9).
- **Requires:**
  - the stack down (`stack:down`; it refuses otherwise);
  - `--key`;
  - `--confirm "replace the stack's data"`, exactly.
- **It keeps what it replaces:**
  - before restoring, it copies `pgdata`, `vault-raft` and `seaweedfs-data` into `univarse-stack-<name>-before-restore-<time>` volumes;
  - it moves `~/.univarse/stack` to `~/.univarse/stack.before-restore-<time>` and writes the set's parts in its place;
  - nothing is deleted. Deleting the copies is the owner's step, as with `vault-data`.
- **Recovery uses the real ledger,** and fails closed exactly as a deploy does.
- **It ends** by printing the deploy command for the release the set names. It doesn't deploy by itself.
- **The disk:** the copies need as much free space as the data. It checks that first, and refuses with the figure.
- **Tested** against throwaway project and volume names, in unit tests (the order, the refusals) and in CI's restore test (B2-13).

**Alternative:** document a manual procedure only. A restore nobody can run under pressure is the real risk, and the routine is already the rehearsal's. Rejected. **The alternative to keeping copies** is replacing in place, which saves the disk space. A restore picked from the wrong set would then be unrecoverable. Rejected.

### B2-13. What runs where

- **Unit** (`tools/stack`):
  - the engine's order, stops and teardown on every failure (BK6);
  - `status`'s figures and warnings at their boundaries (26 h, 1 h);
  - the schedule's exact XML;
  - the WAL range and gap detection;
  - `--to`'s refusals;
  - the scratch ledger's remapping;
  - the drill's expectations (a control that doesn't decrypt fails; a drill tenant still `ok` after recovery fails);
  - `stack:restore`'s refusals and its copies.
- **CI, a new `test:restore` step,** on the real pinned images, without the release's app images:
  - **BK4:** PostgreSQL 18 with a base backup, a row before the target time and one after, the WAL archived, sealed and shipped by the real shipper. Then the engine's PostgreSQL step restores to the time: the first row is present, the second absent;
  - **BK5's second half:** a Raft snapshot from one Vault, sealed, then restored by the engine's Vault step into a fresh Vault and unsealed with the first's key. A probe encrypted before it decrypts after;
  - **files:** B2-8's filer path, with each object read back over S3 and its hash compared. This is where B2-8's open question is answered;
  - **teardown:** after an injected failure, no labelled container or volume remains.
- **The owner's machine:** the full rehearsal and the drill. They need the whole stack and a release, which CI doesn't have (B-16). Their record is BK6's and BK7's evidence. I won't present a CI run as the drill, or the reverse.

### B2-14. Memory

The project's limits:
- PostgreSQL 512 MB, Vault 256 MB, SeaweedFS 256 MB, PgBouncer 64 MB;
- one job at a time, 512 MB.

That's about 1.6 GB at most, beside the stack's 3.5 GB. The drill's note says to stop the dev stack and dev ClamAV first, and the record shows the measured peak.

### B2-15. Evidence: BK9 and BK10

- **BK9:**
  - the scan of every B2 command's output and of the drill record;
  - the temporary directory gone after a rehearsal, failed or not;
  - no artifact or WAL bytes in clear on the host's disk. A test runs the rehearsal's file handling over a temporary root and searches it for a known plaintext.
- **BK10's mutations for B2:**
  - the shred drill passing without the re-apply step (BK7);
  - the control not required to decrypt;
  - teardown skipped on a failure;
  - the real ledger written by a rehearsal;
  - a path not remapped in the scratch ledger;
  - a count mismatch tolerated;
  - the checkpoint not compared;
  - an artifact's hash not checked;
  - a WAL gap accepted;
  - the release not verified;
  - the boundary measured from the newest set instead of the oldest;
  - the 26-hour warning off by its boundary;
  - the schedule registered without `--apply`;
  - `stack:restore` without its confirmation, or without its copies.

### B2-16. Docs

- **[10 §7](../10-infrastructure-and-deployment.md):** the local section: `status`, the schedule, the rehearsal, the drill, the real restore as a runbook, and the measured RTO and RPO.
- **[16 §5](../16-compliance-ndpa.md):** the boundary as `status` measures it.
- **[08](../08-security.md):** the restore's handling of the private key and the scratch ledger.
- **[spec 0006](0006-envelope-encryption.md):** the restore rule, now rehearsed.
- **[18](../18-roadmap.md):** item 7.5, closed only by the owner's drill record.
- **ADR-032:** implemented.
- **This spec:** the implementation notes.

### B2-17. The owner's steps

- **After B2a merges:** `pnpm stack:backup schedule --at <time>`. Read the XML, then run it again with `--apply`. `pnpm stack:backup status` then shows both tasks.
- **After B2b merges:**
  1. Stop the dev stack and dev ClamAV. Connect the drive with the backup key, and set `UNIVARSE_BACKUP_KEY_PASSPHRASE`.
  2. Run `pnpm stack:drill --key <path>`, while nobody is using the app.
  3. Commit the record it writes (a small PR).
- **Neither needs a release,** as above.

## Implementation notes (PR B2a: status, the deploy's warnings, the schedule)

Built as approved (B2-2 to B2-4), with B2-4's amendment (the backup waits for the registry lock itself). **No image changes and no release:** everything is in `tools/stack` and the docs.

**Files** (`tools/stack/src/backup/`):
- `status.ts`: the report, a pure function of its inputs;
- `status-deps.ts`: the real inputs (sets, shipped and staged WAL, the tasks, the ledger), and the schedule's registration;
- `schedule.ts`: the tasks' XML, the crontab lines, and parsing the task query;
- `scheduled.ts`: a scheduled run's lock wait and its log;
- `wal.ts`: gains a read-only listing of the staging volume;
- `deploy.ts`: gains a final `backupWarnings` step.

**Decisions made while building (approved by the owner on 2026-10-25, all seven as built):**
1. **The tasks live in a `\UniVarse\` folder,** named `backup` and `backup-wal`, so they're easy to find in Task Scheduler and can't collide with anything else's.
2. **The task query goes through PowerShell's `Get-ScheduledTaskInfo`, not `schtasks /Query`.** `schtasks` prints its labels in the system's language, while PowerShell gives the result as a number. "Not run yet" (`0x41303`) is no failure, and "running now" (`0x41301`) counts as no failure.
3. **Registration writes the XML as UTF-16 with a byte-order mark,** as its declaration says, to a temporary file that is removed straight after.
4. **`--scheduled`** is the one flag the tasks pass. It does two things:
   - it appends every printed line, timestamped, to the day's log, plus the exit code;
   - for a backup, it waits for the registry lock.

   A run by hand behaves exactly as before.
5. **The deploy prints all of `status`'s warnings,** not only the two B2-3 named (newest set, staged WAL): a missing task or a broken external rule is just as worth seeing. A status that can't be read at all becomes one warning. Nothing blocks.
6. **`schedule --remove`** needs no `--at`.
7. **Off Windows, the user** for the crontab lines comes from the OS when `USERNAME` isn't set. That was found running the command here.

**Evidence.**
- **Unit tests** (`status.spec.ts`, `schedule.spec.ts`, `scheduled.spec.ts`, `deploy.spec.ts`, `entrypoints.spec.ts`):
  - every warning at its boundary (26 h, 1 h);
  - the boundary taken from the oldest complete set;
  - each unreadable source reported and making `ok` false, alone;
  - **the daily task's XML, line by line,** and the WAL task's trigger;
  - nothing run without `--apply`; the UTF-16 file and its removal; a failed registration stopping;
  - the PowerShell query and its result codes;
  - the lock wait with the real registry lock, and the 30-day log;
  - the deploy printing warnings only after it passed;
  - the CLI's refusals, as real processes.
- **Run here, for real, under a temporary home:**
  - `status`: every source it couldn't read was named (no Docker, no ledger, no set), and it exited 1;
  - `schedule --at 13:30`: the crontab lines;
  - `wal --scheduled`: Docker's error logged with the exit code, in a 0700 folder and a 0600 file.
- **Mutations: 50, all killed.** Four survived the first run:
  - three were cases no test isolated, and each now has its own test: an unreadable source making `ok` false on its own, the newest of several shipped files, and the scheduled lock's wiring (moved into `registryLockFor` to be testable);
  - one was a redundant guard, removed. It had also hidden a failed result whose run time couldn't be read, and that case now has a test.

  The infinite-wait mutant first hung the test run instead of failing it. The fake clock now fails a wait that never ends.
- **Not run here:** Task Scheduler itself. This environment is Linux. `schtasks /Create` with this XML, and the PowerShell query, are first exercised on the owner's machine (B2-17).

**Fixed after the owner's first registration (2026-10-25): the tasks' `--dir` argument.**
- **What broke:** this checkout's path comes from a directory URL, so it ends in `\`. Quoted as `"C:\Projects\univarse\"`, the closing `\"` is a literal quote to Windows, so the argument swallowed the rest of the line. pnpm would have received `--dir 'C:\Projects\univarse" stack:backup --scheduled'` and no command, so every scheduled run would have failed.
- **How it was found:** reading the registered XML, then reproduced by starting Node with that exact command line, before either task had run (`0x41303`, not run yet).
- **The fix:** `arg()` doubles the backslashes before the closing quote, as Windows' rules require.
- **The tests:**
  - a pure one;
  - one on a Windows host that has the real command line split exactly as Task Scheduler's launch does (`windowsVerbatimArguments`), with a trailing backslash and spaces. Both fail without the fix.
- **The owner re-registers once:** `pnpm stack:backup schedule --at 02:00 --apply` replaces both tasks (`/F`).

## Implementation notes (PR B2b: the rehearsed restore, the shred drill, the real restore)

Built as approved (B2-5 to B2-17), with B2-4's checkout warning and the backup destination's normalisation. **No image changes and no release:** everything is in `tools/stack`, the restore's compose file and the docs. The owner's drill (B2-17) is the last evidence.

**What runs where** (`tools/stack/src/restore/`):
- **`engine.ts`:** the one routine (B2-5, B2-6). It owns the order, every stop, and the teardown in a `finally`. Every side effect is an injected step.
- **`checks.ts`:** the decisions on the keys job's reports:
  - the row counts;
  - the checkpoint;
  - the control before recovery;
  - decryption after it;
  - which tenants the ledger says are destroyed.
- **`artifact.ts`:** a set opened only after every sealed file matches its index. Each artifact is unsealed as a stream and refused at its end if its plaintext's hash or size differs from the manifest's.
- **`wal-range.ts`:** the segments a target needs, a gap (stop now) told apart from a missing tail (wait), and a later timeline's history file (B2-7).
- **`scratch-ledger.ts`:** B2-10's copy and remapping.
- **`steps.ts`:** PostgreSQL's and Vault's restore and the files' path, each on the volume or container it's given. The rehearsal and CI's test run the same code.
- **`files.ts`:** B2-8: the keys' encoding, the container's input and its report.
- **`target.ts`:** the restore project's names, labelled volumes, compose and job runners.
- **`real.ts`:** the real steps.
- **`drill.ts`:** B2-11's four steps.
- **`record.ts`:** the record and its BK9 scan.
- **`real-restore.ts`:** B2-12's refusals and copies.
- **`memory.ts`:** the peak-memory sampler.
- **`cli.ts`:** the three commands.

Outside that folder:
- **`infra/stack/restore.compose.yml`:** the restore project (`univarse-restore`): no published port, everything labelled `univarse.restore`.
- **`backup/checkout.ts`:** B2-4's checkout record and warning.
- **`backup/config.ts`:** the destination normalised.
- **`wal.ts`:** the shipper takes its staging volume as a parameter, for CI's test.

**Decisions made while building.** All 14 were approved by the owner on 2026-10-26.
1. **Valkey runs in the restore project too.** The keys job boots the worker's module, which connects to Valkey at start. That adds 128 MB: B2-14's figure becomes about 1.7 GB.
2. **Every restore volume is external, created and labelled by the tool,** not by compose. The teardown then finds everything by its label, a crashed run's leftovers included. A real restore points the three data volumes at the stack's own, which carry no label, so a teardown can never remove them.
3. **The restored Vault is always sealed (with the set's own root token) and opened with the set's own unseal key,** whatever state the snapshot's restore left it in. The set's key is then always what opens it (BK5's second half), never assumed.
4. **`--to` is written with a numeric offset** (`2026-10-26 06:41:54.304+00`). PostgreSQL 18 checks `recovery_target_time` at start, before it loads time-zone abbreviations, and refuses ISO's `Z` as an invalid value. **Found by CI's restore test** on its first run: `--to` would have failed on the owner's machine.
5. **The files' path:**
   - The unsealed objects go into a labelled scratch volume, inside Docker, as numbered entries with an index of their encoded keys, so no key is ever a path on any file system.
   - Each object is PUT through the filer, then read back over S3 with curl's own SigV4 and hashed in the container. Only positions and hashes return to the host.
   - **B2-8's open question is answered:** an object written through SeaweedFS 4.48's filer reads back over S3 with its key and bytes unchanged, spaces, nested folders and non-ASCII names included. A probe here showed it on 2026-10-26, and CI's test holds it. The tunnel fallback, which would have bent D9, isn't needed.
   - **Found by the probe:** SigV4 signs the path with unreserved characters literal, so encoding every byte made every signed read fail. `s3Path` encodes exactly what SigV4 does, and a test pins it.
6. **A real restore ships the staged WAL too.** Shipping needs only the staging volume, not a running stack, and that WAL is what a restore to a later `--to` time needs.
7. **A real restore keeps the restored Vault's `vault-init.json`** in the new stack directory, re-issued tokens included, for the deploy that follows.
8. **The ledger's bucket copy is off in both modes.** The restored SeaweedFS has no ledger bucket (D2 leaves it out). Recovery's records aren't marked as copied, so the next deploy's recovery copies them.
9. **The control's allowances:**
   - `key_destroyed` before recovery is allowed only for a tenant whose destruction the set's own ledger head already records;
   - a RETIRED destruction leaves its tenant decrypting, so it counts in neither check;
   - a waiver's planned re-applications count as earlier destructions;
   - a set from another ledger or generation counts every accepted destruction as earlier, the cautious reading.
10. **The memory sampler is a child process.** The restore's steps block for minutes at a time, so a timer in the same process would miss its samples.
11. **The records:**
    - they are named `YYYY-MM-DD-restore-rehearsal.md` and `YYYY-MM-DD-restore-and-shred.md`, with `-2` on a repeat the same day;
    - BK9's scan uses the stack's own secret values, plus Vault token, PEM block and key-file patterns;
    - a record that fails the scan isn't written.
12. **The checkout warning (B2-4):**
    - it records the branch, and whether tracked files differ, in `backup-checkout.json`;
    - untracked files don't count (an uncommitted drill record, say);
    - both scheduled tasks record it.
13. **The destination is normalised when saved and when read.** The doubled separators already stored (`D:\\univarse-backups`) read as the one directory they name, with no step from the owner.
14. **The set's release** is found by matching its deployed digests against `releases/*.json`, then verified with that record's own commit. The restore starts the local registry for it, and stops it in the teardown.

**Evidence.**
- **Unit tests (`tools/stack`):**
  - the engine's order, every stop, and the teardown on each failure: a wrong key, `--to` before the set, the release, the configuration, PostgreSQL, Vault, the tokens, the files, the migrations, the counts, recovery and a thrown step;
  - the WAL wait, the gap and a time target;
  - the drill's expectations;
  - the real ledger's heads;
  - the checks at their edges;
  - the scratch ledger: recovery appends `reapplied` to the scratch copies, and the real files stay byte-identical;
  - a real sealed set opened, streamed, tampered with and opened with the wrong key;
  - the files' encoding and report;
  - the drill's order;
  - the real restore's refusals and copies;
  - the commands' refusals;
  - the record and its scan;
  - the checkout warning;
  - the destination's normalisation.

  The restore modules have 82 tests; the backup's new ones (the checkout, the destination) 8 more.
- **CodeQL's first run on the PR (#123) found two, both fixed and tested:**
  - the record's table cells escaped pipes but not backslashes (`js/incomplete-sanitization`);
  - the record's file was checked for, then written (`js/file-system-race`). It is now created exclusively, and the next name is taken when one exists, so an earlier record is never overwritten.
- **Mutations: 25 of 25 caught,** two for those fixes. The other 23 cover B2-15's list for B2b:
  - the drill passing without the re-application;
  - the control not required to decrypt;
  - teardown skipped on a failure;
  - the real ledger written;
  - a path not remapped;
  - a count mismatch tolerated;
  - the checkpoint not compared;
  - an artifact's hash not checked;
  - a WAL gap accepted;
  - the release not verified;
  - `stack:restore` without its confirmation, or without its copies.

  It also covers: a running stack restored over, `--to` before the set, a wait that never ends, a file with another hash, the probe's failing encoding, a RETIRED destruction counted, an empty drill tenant, the destination un-normalised, a dirty `main` taken for clean, the record not scanned, and the drill out of order.
- **CI's restore test (`test:restore`, B2-13), run here first on the real pinned images, 5 of 5:**
  - **BK4:** PostgreSQL 18 recovered to a time from a sealed base backup and the WAL shipped by the real shipper. The row before is there, the row after isn't, and it promoted. A time past the WAL is refused in PostgreSQL's own words;
  - **BK5's second half:** Vault restored from a sealed Raft snapshot and opened with the first Vault's key; a probe encrypted before decrypts after;
  - **B2-8:** three objects with awkward names through the filer and back over S3;
  - **BK6:** a crashed run's labelled containers and volumes all removed by their label.

  Nothing was left behind.
- **Not run here:** the full rehearsal and the drill. They need the owner's private key and a deployed release (B-16). Their record is BK6's and BK7's evidence (B2-17).

## The re-key (2026-10-27)

The owner lost the passphrase of the first backup key (fingerprint `sha256:90c83219…a2571d84e`) before the first drill. Nothing was leaked: the key file still exists, encrypted, and is kept in case the passphrase is recovered.

- **Every set and WAL segment before the re-key is unreadable** without that passphrase: sets `20261024T161305Z-e2bd` to `20261026T025212Z-d796`, and WAL through `00000001000000000000001B`, plus whatever the old checkout ships before this change reaches it. They are not restore points. Pruning removes them as the new sets replace them (the 7 newest, plus a weekly set for 4 weeks), so the old key file can go once the last of them is pruned.
- **The new key** was made by `keygen` on 2026-10-27, fingerprint `sha256:808332a8904334c0bb3f063a6886cc66f404250a1f7e293fc7ffae33757b4154`. The old `infra/backup/backup.pub` was removed in the same change, since `keygen` never replaces one.
- **The first restorable set** is the first one taken after this change is in the checkout the schedule runs from. The drill runs on it.
- **Not built:** a `rotate` command. A rotation with the old key at hand would re-wrap each set's header to the new key (D5's wrapped random key allows it); with the old key lost there is nothing to re-wrap, so this re-key needs none.

## The owner's first drills (2026-10-27 and 28): two fixes

- **A stop hid its reason** (#125). The CLI prints only a failed drill's last line, so a stop at steps 1 to 3 showed no cause. The first stop was `shred-drill-20261027 exists`: an earlier attempt, with the lost key, had passed steps 1 to 3 that day. The tenant is kept (suspended, its key destroyed, the destruction in the ledger), and the drill ran the next UTC day.
- **The restore never made the set's folders.** Steps 1 to 3 passed on 2026-10-28; step 4 opened the set and verified the release, then stopped writing `stack.tar` back: `certs/` and `edge/` were never created, so making `certs` owner-only found no folder. `writeParts` now makes each folder on a part's path and makes it owner-only, top down, and checks every name before writing any. CI's `test:restore` runs the engine's lower steps, not this one, so only the owner's run could find it; `real.spec.ts` now covers it on both platforms (4 mutations caught).

## Affected docs (in the implementation PRs)

- **[10 §7](../10-infrastructure-and-deployment.md):** the local backup section: what, where, the schedule, the measured boundary, the owner's private key, the same-disk limit, the commands, the drill.
- **[16 §5](../16-compliance-ndpa.md):** the local erasure boundary, measured from the retained sets; the destruction protocol.
- **[08](../08-security.md):** the backup private key among the assets (offline, the owner's); the durable ledger's integrity and its limits.
- **[spec 0006](0006-envelope-encryption.md):** the destruction boundary's restore rule, now built; destruction in production only through the protocol.
- **[spec 0002](0002-audit-and-outbox.md):** A5's external anchoring, still open: D12's checkpoints are not it.
- **[19](../19-decision-log.md):** ADR-032 (below).
- **[18](../18-roadmap.md):** item 7.5; independent audit anchoring before GA, tracked separately; the Phase 0 status.

## ADR-032 (proposed with this spec)

**Local backups sealed to an offline key, Vault on Raft, and a two-phase destruction protocol with a durable ledger outside the stack.**
- **Context:** ADR-030 makes backups with a rehearsed restore a local Phase 0 requirement; spec 0006 requires that a restore can't re-expose a destroyed tenant.
- **Decision:** D3 (PITR), D4 (Raft), D5 (sealed to an offline X25519 key, built on Node's `crypto`), D7–D8 (destruction only through a host-side protocol: `pending`, the transaction, `committed`, each durable outside the stack before the next step; recovery rolls `pending` forward and fails closed on anything it can't decide; every deploy and restore runs it), serialized by one host-side ledger lock, with the preconditions re-checked inside the transaction (D14); a pending destruction completed from the database's own evidence when its transaction committed, replayed when it didn't, and stopped on conflict (D8); and a retired version destroyed only after a grace period exceeding the bounded writer window, and a sweep after it (D15).
- **Consequences:**
  - every restore needs the owner's private key, and a lost private key makes every backup unreadable (the owner keeps two copies, as with the signing key);
  - destruction in the stack becomes an operator command, never an in-app action, until Phase 1 brings a host-side executor;
  - the local erasure boundary is the age of the oldest retained set, about 35 days with the daily schedule;
  - on one machine the ledger's guarantees hold against the stack's loss and against mistakes, not against the machine's owner, and against the disk's loss only with an external destination; and when no configured destination can be read, nothing restarts until the owner reconnects one, or explicitly waives the no-resurrection guarantee, a waiver recorded and reported from then on, which starts a new generation only once its `genesis` is durable on every destination the owner names.

## Out of scope

- **Per-tenant logical exports** (docs/10 §7) and tenant export on offboarding: Phase 1's lifecycle work.
- **Off-machine or cloud copies:** ADR-030; the owner's separate media is the only off-disk copy.
- **Independent audit anchoring** (spec 0002 A5): before GA, separately (D12).
- **A per-tenant KEK**, which would make erasure complete at once (spec 0006's tracked option).
- **Shortening the erasure boundary** by keeping `tenant_data_key` out of long-retention backups (spec 0006's tracked option).
