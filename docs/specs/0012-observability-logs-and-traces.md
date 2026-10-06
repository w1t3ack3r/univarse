# Spec 0012: Observability, first slice — structured logs and traces for the API and worker

**Status:** Draft (2026-10-06), awaiting owner review. D1–D5 below need decisions.
**Phase:** 0 (roadmap: "OTel + Pino").
**Builds on:**
- [docs/14 §1–2](../14-observability-and-operations.md): telemetry pipeline, logging standards;
- [docs/08 §5](../08-security.md): never log secrets, with central, unit-tested redaction;
- [docs/10](../10-infrastructure-and-deployment.md): an in-cluster OTel Collector.

Every AC ID appears in at least one test name.

## Why
When something goes wrong in a deployed UniVarse, the first question is "what happened to *this* request, or *this* job?". Today it can't be answered:
- **Logs aren't JSON.** The API and worker use Nest's default `ConsoleLogger`. The code calls it as if it were Pino, object first: `logger.warn({ tenantId, fileId }, 'message')`. But for `ConsoleLogger` the second argument is the **context**, so one event prints as several human-formatted lines (verified 2026-10-06):

  ```
  WARN [FileScanWorker] Object(3) {
    tenantId: 't-1', …
  }
  WARN [FileScanWorker] Security event: malware detected in an upload
  ```

  `error` calls put the message where the stack belongs. No log pipeline can parse this reliably.
- **No line per request.** Fastify's own logger is off (`logger: false`), so a 500 is logged by `ProblemFilter` but a slow 200, a 403 or a 429 leaves no line at all.
- **No trace ids anywhere.** The `x-request-id` the API returns appears in only a few hand-written messages. A web request, the outbox event it writes, and the email the worker sends can't be connected.
- **No redaction.** Nothing structural stops a future `logger.log({ body })` from writing a password or a session cookie. docs/08 requires central redaction with a unit test; it doesn't exist.

**The goal:** every line the API and worker write is one JSON object with the fields docs/14 requires, secrets can't get into it, and any request or job can be followed end to end, across the outbox, as one trace.

## What exists today (2026-10-06, `main` at `b996ba6`)
- **The API** (`main.ts`, `bootstrap.ts`): Fastify with `logger: false`; Nest's `ConsoleLogger` at `error`/`warn`/`log` (silenced in tests). `genRequestId` accepts a well-formed upstream `x-request-id` or mints a UUID, and the security-headers hook echoes it.
- **The worker** (`worker.ts`): one Nest application context running three loops:
  - the outbox (email delivery);
  - the key sweep;
  - the file scanner.

  There is no BullMQ yet. The "jobs" are these loops and the rows they claim.
- **35 log call sites** (API and worker, excluding CLIs and tests), most object first, some interpolating `tenant=… user=…` into strings. `no-console` is already a lint error outside the CLIs.
- **The outbox:** `outbox_event` rows are written in the request's transaction and delivered later by the worker. Nothing records which request wrote them.
- **File scans:** `file_object` rows are claimed by the worker's scanner loop after `complete`. Nothing links the scan to the upload request.
- **No OpenTelemetry packages** are installed.

## Acceptance criteria
| ID | Criterion |
|---|---|
| OB1 | *One JSON line per event.* The API and worker log through a single Pino instance: Fastify's own logger, plus a Nest `LoggerService` adapter, so `new Logger(ctx)` call sites keep working.<br>• **Shape:** every line is one JSON object on stdout.<br>• **Both call shapes work:** the object-first calls (`logger.warn({…}, 'msg')`) produce one line with the object's fields and `msg`, and `logger.log('msg')` still works.<br>• **Errors:** an `error` call with an `Error` puts it in `err` (type, message, stack). The message never goes to the stack slot. |
| OB2 | *The mandatory fields (docs/14 §2).*<br>• **Always:** `time`, `level`, `msg`, `service` (`api` or `worker`), `env`, `version` (the build's git SHA, or `dev`) and `module` (the logger context).<br>• **During a request:** `requestId` (the same value as the `x-request-id` header), plus `traceId` and `spanId` from the active span.<br>• **When known:** `tenantId`, and `userId`, which is the UUID only, never a name, username or email.<br>• **How:** request-scoped fields come from `AsyncLocalStorage`, so call sites don't pass them.<br>• **The `event` field:** app-code log lines carry a stable `event` name (e.g. `files.scan.malware_detected`), and all existing call sites are migrated. A test fails if an app call site logs without one. |
| OB3 | *One summary line per request.* Each API request ends with one `info` line (`event: http.request`), or `warn` for 4xx after authentication and `error` for 5xx.<br>• **Fields:** method; the **route template** (`/api/v1/files/:id`, never the raw URL with ids); status; duration in ms; `requestId`; `tenantId` and `userId` when known.<br>• **Never:** query strings, request or response bodies, or headers.<br>• **Probes:** health checks log at `debug`, so they don't flood the stream. |
| OB4 | *Secrets can't be logged (docs/08 §5).* Redaction is configured once, centrally, as Pino `redact` paths plus a serializer for `err` and nested objects:<br>• **Covered:** `password`, `newPassword`, `code`, `otp`, `recoveryCode(s)`, `secret*`, `token*`, `authorization`, `cookie`, `set-cookie`, `*.accountNumber` and `nin`, at any depth the config supports.<br>• **Unit test:** each path is replaced by `[redacted]`.<br>• **Leak test:** an integration test drives real flows (login, MFA verify, step-up, password reset, settings write, upload) and captures **every** log line and span attribute they produce. None may contain a password, TOTP or recovery code, session or challenge cookie value, or reset code used in the test. |
| OB5 | *A security stream.* Security events are tagged `stream: "security"` so the collector can route them to longer retention (docs/14 §2): malware detected, invalid session token, account locked, CSRF rejection, step-up failure, and access-guard misdeclarations. A test lists the events that must carry it. |
| OB6 | *Traces for the API.* The OpenTelemetry Node SDK starts **before** the app is imported, with auto-instrumentation for:<br>• HTTP and Fastify: one server span per request, named by method and route template;<br>• `pg` and Prisma: query spans **without** parameter values (`enhancedDatabaseReporting` off);<br>• `ioredis`.<br>**Propagation:** an incoming W3C `traceparent` is honoured; the response carries the `x-request-id` as before, and each log line carries the trace ids. |
| OB7 | *Traces across the outbox and file scans.* Work that runs later is joined to the request that caused it.<br>• **Recording:** a new nullable `traceparent` column on `outbox_event` and on `file_object` (expand only) records the request's context when the row is written.<br>• **Outbox:** the worker's delivery span is a **child** of that context, so request → outbox → email is one trace.<br>• **File scans:** they run under a new trace with a **span link** to the upload's context. A scan is its own unit of work, but it stays navigable from the upload.<br>• **Loop passes:** each worker loop pass is a span (`outbox.pass`, `files.scan.pass`, `keys.sweep.pass`), with one child span per claimed row. |
| OB8 | *Export, configurable and safe.*<br>• **Off by default:** spans export by OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` when it is set; with no endpoint, nothing is exported, and the app runs exactly as now.<br>• **Configuration:** sampling via the standard `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` (D3); resource attributes `service.name`, `service.version` and `deployment.environment`.<br>• **Failure is harmless:** an exporter failure never fails a request or job, and it's logged once, rate-limited.<br>• **Clean shutdown:** on shutdown, pending spans are flushed within a bounded time. |
| OB9 | *Proved against a real collector.* CI starts the OpenTelemetry Collector (pinned image, `file` exporter) from the dev compose profile. It runs one real request plus an outbox delivery through the built API and worker, then asserts that the collector **received** the server span, a DB span and the worker's delivery span, all with the same `traceId`. Locally, the same compose profile optionally adds a trace viewer (D2). |
| OB10 | *No PII in telemetry.*<br>• **Span attributes:** limited to method, route template, status, durations, `tenant.id`, `user.id` (UUID) and `request.id`.<br>• **Not recorded:** query strings, headers (including `cookie`, `authorization` and `set-cookie`), DB parameters or bodies. Request and response header capture stays off.<br>• **Verified:** OB4's leak test checks span attributes too. |

## Design notes
- **One Pino instance per process,** built in `shared/observability/logger.ts`:
  - **The API:** passes it to Fastify (`loggerInstance`), so request logging and the `requestId` are Fastify's own; Nest's `LoggerService` adapter writes to the same instance.
  - **The worker:** uses the adapter only.
  - **The adapter** accepts both Nest's `(message, context)` and Pino's `(obj, message)` shapes.
- **Request context:** `AsyncLocalStorage` holds `{ requestId, tenantId, userId }`. `TenantGuard` and `AccessGuard` fill it as they resolve; the worker loops set `tenantId` per claimed row. A Pino `mixin` adds the store's fields and the active span's ids to every line.
- **OTel bootstrap:**
  - **Start-up:** `src/observability/otel.ts` is loaded with `node --import` in `main.ts`/`worker.ts` start scripts, so instrumentation patches modules before Nest and Prisma load.
  - **Tests:** the SDK is started in-process with an in-memory exporter, so tests can assert spans.
- **`traceparent` columns:** written from the active context inside the same transaction as the row. The worker parses them with the W3C propagator; a malformed value is ignored with a warning, never fatal.
- **Migration:** `<timestamp>_trace_context`, adding nullable columns only, which tenant RLS already covers. No backfill: old rows simply have no link.

## Decisions needed
| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Logger wiring | **(a)** Fastify's own Pino instance + a small in-repo Nest adapter. **(b)** `nestjs-pino` (+ `pino-http`). | **(a).** Fastify is Pino-native and already owns `genReqId`; an adapter of about 60 lines avoids a second request-logging layer and keeps the `(obj, msg)` call sites working. (b) is fine but duplicates what Fastify does. |
| D2 | Local trace viewer | **(a)** Collector only (file/debug exporter). **(b)** Collector + Jaeger all-in-one under an opt-in `observability` compose profile. **(c)** Collector + Grafana Tempo. | **(b)** opt-in: one small image, a UI to read traces locally, off by default (Docker ≥ 4 GB budget, docs/10 §4.1). Tempo matches production but needs Grafana as well; it belongs with staging. |
| D3 | Default sampling | **(a)** `parentbased_always_on` everywhere, tuned later. **(b)** `parentbased_traceidratio` at 0.1 in production, 1.0 elsewhere. | **(b)**, set by environment variable. Nothing is deployed yet, so dev and CI use 1.0; the production ratio is revisited with staging. |
| D4 | Where outbox/scan context lives | **(a)** A nullable `traceparent` column on `outbox_event` and `file_object`. **(b)** Inside the (encrypted) outbox payload. | **(a).** It's not sensitive, it must be readable without decrypting, and it serves file scans, which have no payload. |
| D5 | Request summary level for 4xx | **(a)** `info` for every non-5xx. **(b)** `warn` for 4xx after authentication; `info` before it (401, 404 on probes). | **(b).** A 403, 409 or 412 from a signed-in user is worth a glance; anonymous 401s and 404s are noise. |

## Docs to update in the same change
- **docs/14 §1–2:**
  - the field list as built (`time` rather than `ts`, plus `spanId` and `stream`);
  - the outbox and scan propagation;
  - the "metrics later" note.
- **docs/08 §5:** where the redaction config and its tests live.
- **docs/10:** the collector in the dev compose profile, and its memory.
- **README:** the status row and how to view traces locally.
- **CLAUDE.md:** the start command change, if `--import` alters it.

## Out of scope (tracked)
| Gap | Milestone |
|---|---|
| Metrics (RED, USE and business metrics, docs/14 §3) and SLO alerts (§4–5) | Next observability slice; alerts need staging |
| Next.js server tracing and browser→API trace propagation | With the web performance work |
| Sentry error reporting | Staging (needs a DSN and data-processing review) |
| Loki/Tempo/Grafana deployment, dashboards as code, retention | Staging (spec 0008) |
| BullMQ instrumentation | When BullMQ is introduced |
| Per-tenant debug level via flag | With feature flags |
| Product cache across instances (spec 0003 P7), `GET /users` pagination, key-forget broadcast, shred ledger | Unchanged: still open |
