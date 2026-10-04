# Spec 0002 — Tamper-evident audit log, transactional outbox, durable email

**Status:** Accepted (2026-10-04) · **Phase:** 0 · **Delivery:** PR A (audit) → PR B (outbox + worker + email).
Every AC ID appears in at least one test name. Background: [07 §7](../07-data-and-database.md) (audit design), [ADR-008](../19-decision-log.md) (outbox), spec 0001 R15a (durable email).

---

## Part A — Hash-chained audit log (PR A)

| ID | Acceptance criterion |
|----|----------------------|
| A1 | *Same transaction.* Audit events are written by `AuditWriter.write(tx, …)` inside the business transaction. If the audit write fails, the business change rolls back, and vice versa. |
| A2 | *Per-tenant chain.* Each event has `seq` (1, 2, 3… per tenant, gap-free), `prev_hash` and `hash = SHA-256(prev_hash ‖ canonical-JSON(event fields))`. The first event chains from 32 zero bytes. |
| A3 | *Serialised appends.* Concurrent writers in one tenant never fork the chain. Appends take `pg_advisory_xact_lock` keyed on the tenant. N parallel transactions produce seq 1…N with every link valid. Other tenants aren't blocked. |
| A4 | *Append-only.* The app role can't `UPDATE`, `DELETE` or `TRUNCATE` `audit_event` (grants; already in place, re-tested). |
| A5 | *Verification.* `verifyAuditChain(tenantId)` recomputes every hash and reports the first broken `seq`. It detects (as the schema owner, simulating an insider): a modified field, a deleted event, an inserted event, and a reordered `seq`. |
| A5 limit | **Scope of the claim:** the chain detects tampering that doesn't recompute every later hash (verified: modify, delete, insert, reorder). An insider with owner access who rewrites an event **and recomputes the rest of the chain** is undetectable until the chain head is anchored outside the database (tracked: external anchoring, before GA). |
| A6 | *No secrets.* `before`/`after`/`metadata` pass through a redactor. Keys matching password, code, token, secret, recovery, hash or pepper are replaced with `"[REDACTED]"`, recursively. A test proves a password reset's audit row contains no password, code or hash. |
| A7 | *Identity events.* These are written: `auth.login.succeeded`, `auth.login.failed` (known accounts only), `auth.account.locked`, `auth.logout`, `auth.activation.completed`, `auth.password_reset.completed`, `auth.mfa.enrolled`, `auth.mfa.disabled`, `auth.mfa.recovery_codes_regenerated`, `auth.mfa.recovery_code_used`, `auth.step_up.succeeded`. Each has actor, tenant, `ip`, `user_agent`, `request_id`. |
| A8 | *Isolation.* The audit chain is per tenant under forced RLS. One tenant's events never appear in another's chain or verification (live test as the app role). |
| A9 | *Canonical JSON.* Object keys are sorted recursively and dates are ISO-8601 UTC, so the same event always hashes the same regardless of key order (unit-tested). |

### Part A verification notes (2026-10-04)

- **19 integration tests** (12 writer/verifier in `shared/audit/audit.int.spec.ts`, 7 identity-flow in `identity-audit.int.spec.ts`) plus 5 unit (canonical JSON, redaction).
- **Mutation checks, 6 of 6 caught:** removing the advisory lock (A3, parallel appends fork), skipping hash comparison (A5, 3 tests), disabling redaction (A6), leaving the JSON payload out of the hash (A5), and dropping the logout and disable audit writes (A7).
- **Migration** `20261004000000_audit_seq` is hand-written: Prisma refuses a required column on a non-empty table non-interactively. It lifts FORCE RLS only inside its own transaction to backfill legacy test rows. Verified: zero schema drift, FORCE restored, RLS gate green.
- **Failed logins share one transaction** with the lockout counter (`PasswordAttempts`), so the counter, lock and both audit events commit together.
- Unknown-username login failures aren't audited (there's no actor to attribute them to). They're visible in rate-limit and security logs.

## Part B — Outbox, worker, durable email (PR B)

| ID | Acceptance criterion |
|----|----------------------|
| B1 | *Same transaction.* Emails (and later, other side effects) are **enqueued** as `outbox_event` rows in the business transaction, never sent inline. If the business change rolls back, no email exists. |
| B2 | *Encrypted payloads.* The payload is AES-GCM field-encrypted (ADR-018 key; AAD = tenant + event id), because code emails contain secrets. After successful delivery the payload is **wiped** (`payload_enc = NULL`). |
| B3 | *Worker.* `apps/api/src/worker.ts` (a separate entrypoint) claims due events with `FOR UPDATE SKIP LOCKED` per tenant shard, under tenant RLS context, in small batches. |
| B4 | *Retries.* On failure: `attempts++`, `next_attempt_at = now + backoff` (exponential with jitter, capped), and `last_error` recorded (truncated, no payload content). After **8** attempts the event is `DEAD`, logged at error level, and not retried. |
| B5 | *Durability.* An event written while no worker is running is delivered once a worker starts (simulated restart). |
| B6 | *Exactly-once claim, at-least-once delivery.* Two concurrent workers never deliver the same event twice in the normal path. A crash *after* send but *before* the commit can re-send. That's documented, and the Message-ID is derived from the event id so receivers can de-duplicate. |
| B7 | *Request paths stop sending email.* Activation, reset, MFA and step-up notices go through the outbox. The R15 timing path no longer touches SMTP at all. The 400 ms floors stay. |
| B8 | *Isolation.* Workers process each tenant under that tenant's RLS context. A worker run for tenant A can't claim tenant B's events (live test). |
| B9 | *Observability (minimal).* The worker logs counts per batch (claimed, sent, retried, dead), never payloads. |

## Design decisions (made before implementation)

- **`audit_event.seq`** (bigint, `UNIQUE (tenant_id, seq)`) is added by migration. The existing table is empty outside tests, so there's no backfill.
- **Outbox columns:** `status` (`PENDING`/`SENT`/`DEAD`), `next_attempt_at`, `payload_enc` (nullable). The old `payload jsonb` becomes nullable and unused for emails. App-role grants are widened only to these bookkeeping columns.
- **No BullMQ in Phase 0** (ADR-019): a polling worker over the outbox gives durability and retries without a second system. Revisit when job types need fan-out, priorities or rate-limited queues.

## Out of scope (tracked)

| Gap | Milestone |
|-----|-----------|
| External anchoring of audit hashes (WORM / platform DB) | Before GA (docs/07 §7) |
| Audit viewer UI and export | Phase 2 admin UI |
| Monthly partitioning of `audit_event` | When volume warrants it |
| BullMQ / multi-queue fan-out | ADR-019 revisit trigger |
