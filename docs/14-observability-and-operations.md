# 14 — Observability & Operations

## 1. Telemetry pipeline

- **OpenTelemetry SDK** in the API, worker and Next.js server. Auto-instrumentation for HTTP, Fastify, Prisma, pg, ioredis and BullMQ, plus manual spans for use cases.
- Everything goes to an **OTel Collector** (in-cluster), which fans out to:
  - **Logs** → Loki (or cloud equivalent)
  - **Traces** → Tempo
  - **Metrics** → Prometheus/Mimir
  - **Errors** → Sentry (with source maps, PII scrubbing on)
- Dashboards and alerts are in **Grafana**, provisioned as code (`infra/observability/`).
- Trace context propagates through queues: the job payload carries `traceparent`, so a webhook → job → notification is one trace.

## 2. Logging standards

Built in [spec 0012](specs/0012-observability-logs-and-traces.md).
- **Pino JSON** to stdout. One line per event, and no `console.log` in app code (lint rule).
  - **One shared logger:** the API and worker build theirs from `apps/api/src/shared/observability/logger.ts`. Fastify uses it directly; Nest's `Logger` reaches it through an adapter that accepts Nest's signatures and our object-first ones.
- **Mandatory fields, present as `null` when unknown** (never omitted):
  - `time`, `level`, `msg`, `service` (`api` or `worker`), `env`, `version` (git SHA, or `dev`);
  - `requestId`, `traceId`, `spanId`, `tenantId`, `userId` (UUID only, never names or emails);
  - `module` (the logger context) and `event` (a stable machine name, e.g. `files.scan.malware_detected`).
  - **Where they come from:** request fields come from `AsyncLocalStorage`. `TenantGuard` sets the tenant from the Host, `AccessGuard` sets the user from the session, and the worker loops set the tenant per pass. A source scan fails if an app log call has no `event`.
- **One summary line per request,** `event: http.request`: method, **route template** (never the raw URL or query string), status and duration.
- **Severity by outcome:**
  - `info` for 2xx–4xx, whoever is signed in;
  - `error` for 5xx;
  - `warn` for security events, logged by the code that detects them;
  - `debug` for health probes, and otherwise off in prod unless temporarily enabled per tenant via flag.
- **Redaction** (central, unit-tested), in two layers:
  - **Keys:** object keys at any depth up to 3 (`password`, `code`, `otp`, `recoveryCode(s)`, `secret`, `token*`, `authorization`, `cookie`, `set-cookie`, `accountNumber`, `nin`, …) become `[redacted]`.
  - **Text:** `msg` and error messages and stacks are scrubbed of query strings, header values, our cookie values, bearer tokens and signed storage credentials. Error text also loses quoted literals.
  - **Error codes:** these log as `err.errorCode`, because `code` is a redacted key.
- **Security events** carry `stream: "security"`, so the collector can route them to a separate stream with longer retention (12 months). The list is `SECURITY_EVENTS` in `shared/observability/security.ts`; a test requires each to be logged somewhere. Logs are never sampled.
- **Application logs aren't the audit log.** Audit events are business records in the DB ([07 §7](07-data-and-database.md)).

## 3. Metrics

**RED** per route/job (rate, errors, duration) and **USE** per resource, plus business metrics:

| Metric | Type | Labels |
|--------|------|--------|
| `http_server_duration_seconds` | histogram | route, method, status_class |
| `jobs_processed_total`, `job_duration_seconds`, `queue_depth`, `queue_oldest_age_seconds` | counter/histogram/gauge | queue |
| `db_pool_in_use`, `db_query_duration_seconds` | gauge/histogram | shard |
| `payments_total` | counter | gateway, status |
| `payments_reconciliation_mismatches` | gauge | gateway |
| `webhook_signature_failures_total` | counter | gateway |
| `logins_total` | counter | result (`success`/`bad_credentials`/`locked`/`mfa_failed`) |
| `results_published_total`, `scoresheets_by_status` | counter/gauge | — |
| `outbound_messages_total` | counter | channel, status |
| `rls_violations_total` | counter | — (must stay 0) |

**Cardinality rule:** `tenant` is allowed as a label only on a small set of business metrics (fine for ≤ a few hundred tenants). Never use `userId`, `studentId`, raw URLs or IDs as labels.

## 4. SLOs

| SLI | SLO (GA) | Window |
|-----|----------|--------|
| Availability: successful (non-5xx) API requests / all | **99.9%** (pilot 99.5%) | 30 days |
| Latency: API reads p95 | < 300 ms | 30 days |
| Latency: API writes p95 | < 800 ms | 30 days |
| Payment processing: webhook received → invoice credited | 99% < 60 s | 7 days |
| Notification delivery handed to provider | 99% < 5 min | 7 days |
| Result publication job completion (per sheet batch) | 99% < 10 min | 7 days |

Error budgets drive the release pace. If the budget is exhausted, freeze features and fix reliability.

## 5. Alerting

Multi-window, multi-burn-rate alerts on SLOs, plus symptom alerts:

| Alert | Severity | Route |
|-------|----------|-------|
| Availability fast burn (2% budget in 1h) | Page | On-call |
| Payment webhook backlog > 5 min / processing failures > 1% | Page | On-call + bursary contact of affected tenant (status message) |
| Reconciliation mismatch unresolved > 48h | Ticket | Tenant bursary + support |
| `rls_violations_total` > 0, cross-tenant session attempts spike | Page (security) | On-call + security |
| Webhook signature failures spike | Page (security) | On-call |
| Queue oldest job age > 10 min (any queue) | Page | On-call |
| DB CPU > 80% for 15 min / connections > 85% / replication lag > 60 s | Page | On-call |
| `server.busy` (503, log event `db.connection_unavailable`) > 0.5% of requests on a shard for 5 min ([ADR-026](19-decision-log.md)) | Page | On-call: scale API replicas or the shard, per [10 §4.1](10-infrastructure-and-deployment.md) |
| Backup job failed / PITR lag | Page | On-call |
| Certificate expiry < 14 days | Ticket | Ops |
| Error rate per tenant anomaly | Ticket | Support |
| Audit hash-chain verification failure | Page (security, Sev-1 candidate) | On-call + security |

Every page links a runbook. An alert without a runbook isn't allowed in `Enforce`.

## 6. Runbooks (`docs/ops/runbooks/`) — required before pilot

| Runbook | Covers |
|---------|--------|
| `incident-response.md` | Severity, roles (IC, comms, ops), timeline template, tenant/NDPC notification support ([08 §12](08-security.md)) |
| `api-high-error-rate.md` | Triage by route/tenant/dependency, rollback |
| `db-high-load.md` | Slow queries, killing runaway queries, pool saturation, scaling |
| `db-restore-pitr.md` | Full restore to a timestamp |
| `tenant-restore.md` | Single-tenant logical restore into the pool/dedicated shard |
| `payment-webhooks-backlog.md` | Replay, re-verify, reconciliation |
| `gateway-outage.md` | Status page, switch the tenant's preferred gateway, communicate |
| `queue-stuck.md` | Inspect/retry/dead-letter handling in BullMQ |
| `result-publication-failed.md` | Re-run publication idempotently, verify GPA snapshots |
| `security-account-compromise.md` | Revoke sessions, reset MFA, review audit, notify |
| `cross-tenant-suspected.md` | Sev-1 containment steps, evidence preservation |
| `suspend-tenant.md` / `offboard-tenant.md` | Lifecycle operations |
| `rotate-secrets.md` | DB passwords, KMS keys, gateway keys, session secrets |
| `certificate-issues.md` | Custom domain TLS failures |
| `peak-day-prep.md` | Pre-scale, freeze deploys, extra monitoring for result/registration days |

## 7. Health endpoints

- `GET /health/live`: the process is up (no dependencies checked).
- `GET /health/ready`: DB (platform + at least one shard), Redis, and storage reachable within 500 ms. Otherwise 503 (the pod is removed from the LB).
- `GET /health/deps` (internal only): detailed dependency status for dashboards.

## 8. On-call & support model

- Pilot: the founder is on call. Paging via Grafana OnCall / PagerDuty / Opsgenie to phone. Business-hours support for tenants, plus pages for Sev-1/2 24×7.
- **Status page** (e.g. hosted Upptime / Instatus) at `status.univarse.ng` with per-component status and incident history.
- Tenant support tiers: L1 = the institution's own ICT helpdesk (UniVarse helpdesk module), L2 = UniVarse support (platform tickets), L3 = engineering.
- Support SLAs by priority (P1 critical: response 1h, 24×7; P2: 4 business hours; P3: 1 business day; P4: best effort).

## 9. Operational calendar

- Daily: reconciliation review, backup success check, error triage.
- Weekly: dependency updates, alert noise review, cost check.
- Monthly: patch window, access review (platform staff and tenant admins with privileged roles), SLO report to tenants.
- Quarterly: restore drill, threat-model refresh, kube-bench, secrets rotation where due.
- Per tenant calendar: peak-day prep before registration deadlines and result publications.
