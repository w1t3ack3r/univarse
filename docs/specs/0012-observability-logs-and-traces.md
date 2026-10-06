# Spec 0012: Observability, first slice — structured logs and traces for the API and worker

**Status:** Accepted (2026-10-06), owner review. D1–D5 decided; the conditions are written into the criteria.
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

**The goal:** every line the API and worker write is one JSON object with the fields docs/14 requires, secrets can't get into logs **or** traces, and any request or job can be followed end to end, across the outbox, as one trace.

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
| OB1 | *One JSON line per event, one shared configuration.* The API and worker build their logger from **one shared module** (`shared/observability/logger.ts`): same fields, levels, redaction and serializers.<br>• **The API:** gives that Pino instance to Fastify (`loggerInstance`).<br>• **Both:** route Nest's `Logger` through an in-repo `LoggerService` adapter onto it.<br>• **Every call shape is tested to give one JSON line, with `msg` the message and `module` the context:**<br>&nbsp;&nbsp;– Nest's normal signatures, `log(msg)`, `log(msg, context)`, `warn(msg, context)`;<br>&nbsp;&nbsp;– Nest's error signatures, `error(msg)`, `error(msg, stack)`, `error(msg, stack, context)`, `error(err)`;<br>&nbsp;&nbsp;– the object-first call sites, `warn({…}, msg)` and `error({ err }, msg)`.<br>• **Errors:** an error's type, message and stack go to `err`, and its message is scrubbed as in OB4. A stack never ends up as the message. |
| OB2 | *The mandatory fields, present even when unknown.* Every line has:<br>• **Always set:** `time`, `level`, `msg`, `service` (`api` or `worker`), `env`, `version` (the build's git SHA, or `dev`) and `module`.<br>• **Inside a request or claimed job:** `requestId`, `traceId`, `spanId`, `tenantId`, `userId` and `event`.<br>• **When a field isn't known, it is present as `null`, not omitted.** For example, `userId: null` before authentication (and always on public routes), `tenantId: null` on tenantless routes (health), and `requestId: null` in worker loop passes.<br>• **Where they come from:** request and job fields come from `AsyncLocalStorage`, which `TenantGuard` and `AccessGuard` fill as they resolve, and the worker fills per claimed row. Call sites don't pass them.<br>• **`event` is required in app code:** a stable name (e.g. `files.scan.malware_detected`) on every call site; all 35 are migrated, and a test fails if one logs without it. |
| OB3 | *One summary line per request; severity by outcome (D5).* Each API request ends with one line, `event: http.request`, giving method, **route template** (`/api/v1/files/:id`), status, duration in ms, `requestId`, `tenantId` and `userId`.<br>• **Severity:**<br>&nbsp;&nbsp;– `info` for 2xx–4xx, **whether or not anyone is signed in**: being signed in never changes severity;<br>&nbsp;&nbsp;– `error` for 5xx.<br>• **Security events are separate lines** at `warn` on the security stream (OB7): lockout, rate-limit violation (429), CSRF rejection, invalid session token, step-up failure, malware detected. They're logged by the code that detects them, never inferred from a status code.<br>• **Probes:** health checks log at `debug`. |
| OB4 | *Logs can't carry secrets (docs/08 §5).* Pino `redact` covers object paths, but it doesn't see secrets **inside strings**, so both layers are tested:<br>• **Paths:** `password`, `newPassword`, `code`, `otp`, `recoveryCode(s)`, `secret*`, `token*`, `authorization`, `cookie`, `set-cookie`, `*.accountNumber` and `nin` become `[redacted]`, at any depth.<br>• **Strings:** a serializer scrubs `msg`, `err.message` and `err.stack` of:<br>&nbsp;&nbsp;– raw URLs and query strings: a URL is logged as origin + path only;<br>&nbsp;&nbsp;– header values (`Cookie:`, `Authorization:`, `Set-Cookie:`);<br>&nbsp;&nbsp;– our cookie names with their values;<br>&nbsp;&nbsp;– bearer tokens;<br>&nbsp;&nbsp;– signed storage credentials (`X-Amz-Signature`, `X-Amz-Credential`, `Policy`, `X-Amz-Security-Token`);<br>&nbsp;&nbsp;– quoted SQL literals.<br>• **Unit tests:** one case per path and per pattern. |
| OB5 | *Traces can't carry secrets, protected separately from logs.* Span attributes aren't covered by Pino redaction, so traces get their own controls:<br>• **HTTP:** no request or response headers captured; `url.query` and the query part of `url.full` dropped; span names use the route template.<br>• **Databases:** pg and Prisma report statements **without parameter values** (`enhancedDatabaseReporting` off), and a span processor replaces any quoted or numeric literals left in `db.statement` with `?`.<br>• **Valkey:** `ioredis` spans record the command name only (`dbStatementSerializer` returns the command, never its arguments, keys or values).<br>• **Exceptions:** recorded with type and a **scrubbed** message (OB4's patterns), never an unscrubbed stack.<br>• **An allowlist backstops it all:** a sanitizing span processor removes any attribute that isn't on a reviewed list and logs the dropped key once. |
| OB6 | *Leak test, both ways: nothing leaks, and something useful is there.* An integration test drives the real flows: login, MFA verify, step-up, password reset, a settings write, and an upload + scan + download using a **presigned POST**. It captures every log line and every span (in-memory exporter) and asserts both directions:<br>• **Nothing leaks:** no password, TOTP or recovery code, session or challenge cookie value, reset code, `X-Amz-Signature` / `Policy` / credential, or query string from the test appears in **any** log line or span attribute, name or event.<br>• **Useful output exists:**<br>&nbsp;&nbsp;– each flow produced its `http.request` lines, with route template, status and ids;<br>&nbsp;&nbsp;– its server spans, with at least one pg span and one Valkey span as children;<br>&nbsp;&nbsp;– the expected security events (a wrong-password lockout, a 429).<br>A test that only proved silence would pass on an app that logs nothing. |
| OB7 | *The security stream, never sampled.* Security events carry `stream: "security"`, so the collector can route them to longer retention (docs/14 §2).<br>• **The events:** lockout, rate-limit violation, CSRF rejection, invalid session token, step-up failure, malware detected, and access/product-guard misdeclarations. A test lists them.<br>• **Never sampled:** **logs are never sampled at all**, and trace sampling (D3) has no effect on whether a security line is written. A test logs a security event inside a span the sampler dropped and asserts the line exists, still carrying its `traceId`. |
| OB8 | *Context stays isolated.* **Overlapping** requests and jobs for tenants A and B, with different users, are run interleaved: concurrent HTTP requests, plus the worker processing outbox rows and scans for both tenants in one pass.<br>• **Every line and span is attributed correctly:** `tenantId`, `userId` and `traceId` all belong to the request or row that produced it, with no bleed between tenants or actors.<br>• **Trace headers carry no authority:** an incoming `traceparent` or `baggage` only parents the span. Tenant and actor come from the Host and the session, never from trace context.<br>• **Tested:** a request with `baggage: tenant.id=<B>, user.id=<x>` to tenant A's host is logged and traced as tenant A and its real (or `null`) user, and baggage is never copied into log fields or span attributes. |
| OB9 | *Traces for the API, initialized first.* The OpenTelemetry Node SDK starts **before any instrumented library loads**: an `--import` module in the compiled start commands for both the API and the worker. Late initialization can leave instrumentation silently inactive.<br>• **Instrumented:** HTTP and Fastify (one server span per request, named method + route template), `pg`/Prisma and `ioredis`, under OB5's controls.<br>• **Proved active:** OB12 asserts pg and Valkey child spans exist in the compiled processes. |
| OB10 | *Traces across the outbox and file scans (D4); sampling preserved (D3).*<br>• **Recording:** nullable `traceparent` columns on `outbox_event` and `file_object` record the request's context, written **in the same transaction** as the business row.<br>• **Outbox:** the worker's delivery span is a **child** of the stored context, so request → outbox → email is one trace.<br>• **File scans:** they run under a new trace with a **span link** to the upload's context.<br>• **Sampling is preserved:** the worker honours the stored context's sampled flag. A delivery whose request wasn't sampled isn't sampled; a scan is sampled exactly when the linked upload was.<br>• **Old rows still work:** rows with a **null** or malformed `traceparent` (all rows written before this change) process normally under a fresh root, malformed values with one warning. Tests cover both.<br>• **Loop passes:** each pass is a span (`outbox.pass`, `files.scan.pass`, `keys.sweep.pass`), with one span per claimed row. |
| OB11 | *Exporter failure is bounded and measurable.*<br>• **Export:** spans go out by OTLP/HTTP only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; with none set, nothing is exported and behaviour is unchanged.<br>• **Configured bounds,** asserted in a unit test of the SDK config: batch processor `maxQueueSize`, `maxExportBatchSize`, `scheduledDelayMillis` and `exportTimeoutMillis`, plus a shutdown flush deadline.<br>• **Tested against two failing collectors:** **unavailable** (connection refused) and **stalled** (accepts the connection, never answers). In both:<br>&nbsp;&nbsp;– requests and worker jobs complete, within their normal latency plus a small margin;<br>&nbsp;&nbsp;– the span queue never grows past its bound: overflow is dropped and **counted**, with one rate-limited `warn`;<br>&nbsp;&nbsp;– shutdown finishes within the flush deadline. |
| OB12 | *Proved against a real collector, compiled and as separate processes.* CI starts the OpenTelemetry Collector (pinned image, `file` exporter) from the dev compose profile, then runs the **compiled** API (`dist/main.js`) and worker (`dist/worker.js`) as **two separate processes**, each with its own `--import` initialization. Two journeys go through them:<br>• **Email:** a password-reset request whose email the worker delivers.<br>• **File scan:** an upload completed, then scanned by the worker.<br>From the collector's file output, assert the **structure**, not just matching trace ids:<br>• the outbox delivery span's **parent chain** leads to the reset request's server span, with the correct `traceId`;<br>• the scan span has a **link** to the upload's span context;<br>• both processes produced pg and Valkey child spans;<br>• `service.name` is `api` for the API's spans and `worker` for the worker's.<br>Locally, the same compose profile can add Jaeger to view traces (D2). |

## Design notes
- **One logging module, two processes.** `shared/observability/logger.ts` builds the Pino instance (fields, redaction, serializers, mixin), and both entry points use it.
  - **The API:** passes it to Fastify (`loggerInstance`, which keeps `genReqId`).
  - **The Nest adapter** maps both Nest's signatures and Pino's object-first shape onto it.
- **Request and job context:** `AsyncLocalStorage` holds `{ requestId, tenantId, userId }`, initialised with `null`s. A Pino `mixin` adds the store's fields plus the active span's ids.
- **OTel bootstrap:**
  - **Start commands:** `src/observability/otel.ts` is compiled to `dist/observability/otel.js` and loaded with `node --import ./dist/observability/otel.js dist/main.js` (and the same for `worker.js`).
  - **Tests:** a test helper starts the SDK in-process with an in-memory exporter.
- **Sampling:** `parentbased_traceidratio` (D3); `OTEL_TRACES_SAMPLER_ARG` defaults to 1.0 outside production and 0.1 in production (provisional).
  - **Worker rows:** these have no live parent, so their stored `traceparent` is extracted and used as the parent (outbox) or link (scans). The sampler is configured so a link's sampled flag decides the scan's sampling.
- **`traceparent` columns:** written from the active context inside the business transaction, and parsed by the W3C propagator in the worker.
- **Migration:** `<timestamp>_trace_context`, adding nullable columns only, which tenant RLS already covers. No backfill.

## Decisions (owner, 2026-10-06)
| # | Decision | Conditions (in the criteria) |
|---|---|---|
| D1 | **Fastify's Pino logger + an in-repo Nest adapter.** | **OB1:** one logging configuration shared by the API and worker; Nest's normal and error signatures tested. |
| D2 | **Optional Jaeger,** off by default, local only. | **OB12:** a compose profile; ports bound to 127.0.0.1. |
| D3 | **Sampling:** 100% in dev and CI; a configurable, provisional 10% production default. | **OB10:** workers keep the originating sampling decision. **OB7:** security logs are never sampled. |
| D4 | **Nullable `traceparent` columns** on `outbox_event` and `file_object`. | **OB10:** written in the business transaction; rows without context still process. |
| D5 | **Severity by outcome:** `info` for ordinary 4xx, `warn` for security events (lockouts, rate-limit violations…), `error` for 5xx. Being signed in never decides severity. | **OB3**, **OB7**. |

## Docs to update in the same change
- **docs/14 §1–2:**
  - the field list as built (`time` rather than `ts`; `spanId`, `stream`, `null` for unknown);
  - severity by outcome;
  - the propagation and sampling rules;
  - the "metrics later" note.
- **docs/08 §5:** log redaction **and** trace sanitization, where each lives and how each is tested.
- **docs/10:** the collector and the optional Jaeger in the dev compose profile, and their memory.
- **README:** a status row, and how to view traces locally.
- **CLAUDE.md:** the start command change (`--import`).

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
