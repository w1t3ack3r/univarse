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

## Implementation notes
### Logs (OB1–OB4, OB7; OB2's worker context) (2026-10-06)
- **Code:** `apps/api/src/shared/observability/`:
  - `logger.ts`: the shared Pino factory, redaction paths, the error serializer, the context mixin and `NestPinoLogger`;
  - `context.ts`: `AsyncLocalStorage`;
  - `scrub.ts`: string patterns, reused for traces;
  - `http-logging.ts`: the context hook and the summary line;
  - `security.ts`: `SECURITY_EVENTS` and `securityFields`.
- **Wiring:**
  - **`bootstrap.ts`:** gives the Pino instance to Fastify (`loggerInstance`) and to Nest (`NestPinoLogger`). Fastify's own request logging is off through `logController: new LogController({ disableRequestLogging: true })`; the top-level `disableRequestLogging` option is deprecated in Fastify 5.12 and printed a non-JSON warning.
  - **`worker.ts`:** uses the same factory as service `worker`.
  - **Config:** `LOG_LEVEL` and `UNIVARSE_VERSION`. Tests are silent unless they capture lines.
  - **Request context:** `TenantGuard` and `AccessGuard` set `tenantId` and `userId`; the outbox and file-scan loops run each tenant's pass in its own context.
- **Call sites:** all 35 migrated to `{ event, … }`. Strings that interpolated `tenant=…`/`user=…` became fields. Three security events had **no log line before** and now do:
  - rate-limit violations (both 429 throw sites, logging the bucket *name* only, since the key embeds the IP and identifier);
  - CSRF rejections;
  - step-up failures.
- **Two corrections found by tests:**
  - **Hyphenated keys:** `set-cookie` needed bracket syntax in Pino `redact` paths; a quoted dot path silently matched nothing.
  - **Error text:** a message taken from an `Error` is foreign text, so it gets the stronger scrub that also hides quoted literals.
- **Deviation:** `code` is redacted, as the spec lists, so error codes are logged as `err.errorCode`, keeping Prisma's `P2002` and similar visible.
  - **Only recognized machine codes** get there (`isMachineCode`): Prisma `P####`, Node/system `E…`/`ERR_…`, five-character SQLSTATE, and our dotted problem codes.
  - Anything else in an error's `code` (an OTP, a reset code, free text) is dropped, never logged. OTP fields stay redacted. Tested in `[OB4] only recognized machine codes reach err.errorCode`.
- **`AsyncLocalStorage` is for observability only.** Database tenancy and authorization keep using the explicit tenant context (`req.tenant`, `ShardRegistry.forTenant`/`tx`) and the loaded actor. Nothing reads the log context to make an access decision.
- **OB7's sampling proof is pending.** The security events are logged, and logs are never sampled by construction. The proof that a security line is still written when a real trace is **dropped** needs the sampler, so it lands with the tracing tests.
- **CI note:** gitleaks flagged a test's fake signature-shaped string (`generic-api-key`). It is now built at run time, as this repo does for other secret-shaped test values.
- **Tests:**
  - **Unit:** `logger.spec.ts` (19: OB1 every Nest and object-first signature, OB2 fields and null-when-unknown and no bleed between contexts, OB4 every path and pattern) and `call-sites.spec.ts` (6: OB2 every call has an `event`, nothing interpolates tenant or user, OB7 the exact event list, each logged somewhere).
  - **Integration:** `logging.int.spec.ts` (7, against the real app: OB3 public 200, signed-in 404 by template with user from the session, query strings never logged, 5xx at error, health at debug; OB7 CSRF and 429 security lines).
- **Mutations caught (7):**
  - 5xx at `info`;
  - the raw URL instead of the template;
  - `userId` not set from the session;
  - hyphenated keys back to quoted paths;
  - a call site without `event`;
  - the CSRF security line removed;
  - the adapter taking a stack as the context.
- **Compiled smoke:** `dist/main.js` and `dist/worker.js` wrote 47 and 5 lines, **all JSON**; the summary line carried `requestId`, `tenantId` and the route template.
- **API integration:** 329 passed, 1 skipped.

### Traces for the API (OB5, OB6, OB7's sampling proof, OB8 requests, OB9; OB11's no-endpoint check) (2026-10-07)
- **Code:**
  - `shared/observability/tracing.ts`:
    - `NodeTracerProvider`, with an explicit processor list: the sanitizer, then a bounded `BatchSpanProcessor` only when an exporter exists;
    - instrumentations: HTTP (no headers; the server span named by route template), `@fastify/otel`, `pg` (`enhancedDatabaseReporting` off), `ioredis` (command name only) and `@prisma/instrumentation`;
    - the W3C trace-context propagator only (no baggage);
    - the logger's span-id provider.
  - `src/otel.ts`: the `--import` entry, used by `pnpm start`, `start:worker` and the E2E launcher.
- **Request context:** the request's root span is `@fastify/otel`'s `request` span, held in the observability-only context. `request.id`, `tenant.id` (from the Host) and `user.id` (from the session) are set on it as they resolve. It's renamed to method + route template in `onRequest`, and the raw path never names a span.
- **Fixes recorded:**
  - **Preload deadlock.** `await waitForAllMessagesAcknowledged()` inside the `--import` preload never resolves: the compiled API hung silently before starting. `otel.ts` registers the hook without waiting, and the compiled smoke below shows every instrumentation active anyway. The in-process test helper does wait; there it resolves.
  - **Vitest-only `ioredis` workaround.** Vitest imports externals through its own loader, and the `ioredis` instrumentation doesn't see that load (pg, reached through Prisma's adapter, is fine). A standalone Node probe showed `ioredis` instrumented normally. The test helper loads `ioredis` once through `require` after starting tracing, which patches Node's CommonJS cache that the app's later import reuses. Compiled processes need no workaround.
  - **Test-induced timing.** Synchronous per-span export in the test helper slowed requests enough to hit Prisma's 2 s transaction wait (P2028) at 24 concurrent requests. The helper now batches like production (`flush()` before assertions), and all 24 overlapping requests pass, repeatedly. The underlying capacity question (24 authenticated requests on one shard against a pool of 10) is tracked separately.
- **Evidence, kept distinct:**
  - **In-process tests** cover sanitization, sampling and request-context isolation:
    - `tracing.spec.ts` (7): OB5's allowlist with each drop reported once, SQL literals to `?` with `$n` kept, string scrubbing, and exception events reduced to type plus a scrubbed message; **OB7's sampling proof**, where a security event inside a span the sampler *dropped* is still logged with that trace id and nothing is exported; OB11's bounds.
    - `tracing.int.spec.ts` (4): **OB9**, a login's root named `POST /api/v1/auth/login` with pg and Valkey descendants and logs carrying its trace id. **OB6**, the leak test: 15 secrets across lockout, 429, login, MFA verify, step-up, password reset, a settings write, and a presigned upload, scan and download. None appears in any of 75 log lines or ~2,550 spans, and every flow's summary line, root span, security events and pg, Valkey and Prisma scopes are present. **OB8**: 24 overlapping requests for tenants A and B, every line and root span attributed correctly with no shared traces; baggage naming tenant B on A's host changes nothing, and `traceparent` only parents.
  - **The compiled API smoke shows instrumentation working outside Vitest:** `node --import ./dist/otel.js dist/main.js` against a local OTLP receiver sent 86 spans covering HTTP, Fastify, pg, `ioredis` and Prisma. Roots were named by template (`GET /api/v1/tenant/public-profile`, `POST /api/v1/auth/login`), and the query-string value sent was absent.
  - **The compiled worker starts** with `--import`.
  - **No endpoint, nothing exported (OB11, partial):** `no-export.int.spec.ts` spawns the **compiled** API and worker with no `OTEL_*` variables, while a receiver listens on the OTLP default port (4318). Under traffic and worker passes over 6 s, it gets **zero** requests.
    - **Real traffic:** sent with `node:http`, because `fetch` won't send a custom `Host`. A first draft's "tenant" requests were silently 404s; the test now asserts each tenant request is a **200** with DB work.
    - **Mutation:** setting the endpoint makes the test fail. The provider is built with explicit processors (no `NodeSDK`), so nothing auto-configures an exporter.
- **Overhead, measured:** compiled API, login latency over `node:http`, 200 responses only, two rounds each:
  - **Without tracing:** medians 101 and 80 ms.
  - **With the preload at 100 % sampling:** medians 128 and 97 ms.

  That's roughly +20–25 ms (about 20–25 %) per login with sampling at 100 %. Production's provisional 10 % sampling records fewer spans.
- **D3 performance evidence, under load (2026-10-07, DB pool investigation, ADR-026):**
  - **The machine:** these are measurements from the **memory-starved development laptop** (8 GB RAM, already at 100 % CPU with under 1 GB free before the run). They are not production throughput figures.
  - **The load:** authenticated `GET /api/v1/files` against the compiled API, with pool 10 and a 2 s wait.
  - **The result:** with tracing at 100 %, throughput was roughly half (10–45 vs 32–70 req/s), and pool-wait failures started 2–4× sooner (at 32–64 concurrent instead of 128 or never).
  - **What it supports:** revisiting the sampling ratio, and re-measuring on staging hardware (ADR-026).
  - **What it doesn't establish:** production throughput, or how much of the cost 10 % sampling would recover.
- **Local E2E: cause measured; a clean local run is pending.** The failures **also reproduced without tracing**. They stay open until a local run passes 32/32. CI's E2E passed 32/32 on the merged commit. The failure output below is kept as-is.
  - **The cause measured (2026-10-07, a separate investigation):**
    - **Memory:** the laptop's memory was 96–97 % used, with 2,300–3,100 pages a second read back from disk. CPU was at or above 95 % in 99 % of samples.
    - **The Docker/WSL VM** had 3.3 GB allocated but about 295 MB in RAM, so the containers it hosts (Valkey, Vault, ClamAV, Mailpit) were mostly swapped out.
    - **Valkey latency:** an independent probe measured Valkey PING at p50 48 ms, p90 318 ms and max **3,720 ms**. Postgres `SELECT 1` on the same host stayed at p50 0.6 ms and max 3.4 ms.
    - **Where a stalled login spent its time:** the browser, the edge and the API's own log each saw about 7.2 s, so the time was inside the API. Across the run's logins, about 68 % of login time was Valkey (three sequential rate-limit calls of 217–653 ms each). Pool acquisition was about 0.1 ms, and Postgres queries were 4 %.
    - **The run:** zero 5xx and zero P2028 over 936 requests. The other failures (a Vault call in `makeUser`, a slow ClamAV scan, late emails with outbox delivery p90 7.4 s) all go through the same Docker VM.
  - **A separate test bug, fixed separately:** an axe `color-contrast` race. The step-up dialog fades in over 280 ms, and axe could scan it while it was still partly transparent: 0.52 opacity at 30 ms gave 3 violations, and the scan was clean from 100 ms. The fix waits for finite animations before axe scans, with no timeout raised. It's not part of the tracing work.

  | Run (2026-10-07) | Result | Failing tests | Failure |
  |---|---|---|---|
  | With the tracing preload, 1 | 29/32, 8.4 min | desktop `auth.e2e.ts:35` login → workspace; desktop `auth.e2e.ts:54` [W6] gated item; desktop `settings.e2e.ts:50` [ST13] | `toHaveURL` timed out after 5 s, still on `/login` with the button at "Signing in…" (disabled) |
  | With the tracing preload, 2 | 31/32, 7.2 min | mobile `flows.e2e.ts:31` [W11][W15] activation | the "Check your email" heading wasn't visible 5 s after "Email me a code" |
  | Without the preload (A/B) | 29/32, 5.8 min | desktop `auth.e2e.ts:35`; desktop `settings.e2e.ts:50`; mobile `auth.e2e.ts:74` [W10][W5] recovery code | the same shape: a UI wait after an API call exceeded 5 s |

  For comparison, an earlier clean local run took 4.1 min (32/32), and the compiled API's login measured 80–130 ms over `node:http`.
- **Still open, owned by OB10–OB12:**
  - request → job propagation (outbox, file scans) and sampling preserved in the worker;
  - OB8's worker half (A/B rows in one pass);
  - the unavailable and stalled collector tests and graceful shutdown flush;
  - the separate-process proof against a real collector in CI.
- **Unrelated flakes found and fixed while stress-testing** (every full parallel `pnpm test` run, with output kept):
  - **The "unexplained" crypto failure, now explained.** The fake-Vault tests gave the client a 200 ms timeout, which fired for *answered* requests under parallel load. Three shapes were seen:
    - an `ok` retry timed out;
    - a first attempt timed out before reaching the server (1 call, not 2);
    - a 403 arrived after the client had retried.

    The fix is a 1.5 s default, so only scripted hangs time out. It's a test-margin issue, not a product bug.
    - **Production is unchanged:** `providers.ts` still has a 3 s timeout and 2 attempts, and its diff is empty.
    - **The tests still catch real retry bugs** after the wider margin. Each mutation of `providers.ts` fails them:
      - no retry: fails "retries a timeout or a 5xx once" and "fails closed after the retry";
      - 4xx retried: fails "never retries a 4xx";
      - timeout not transient: fails both hang tests.
  - **Two default 5 s timeouts were too tight under load:** the domain property tests (6.6 s) and the api-client freshness check (16 s).
  - After the fixes, **four consecutive full parallel runs passed:** domain 41, api-client 14, crypto 14, API 150.
- **Also fixed:** the error-messages source scan treated any `['x.y', '…` literal as a filter default and picked up `'db.statement'`. It now anchors on the `400: ['code', 'Title']` shape; all 8 defaults still match, and nothing in `tracing.ts` does.
- **Counts:** API unit 150; API integration 334 passed, 1 skipped.
- **Status:** spec 0012 remains **in progress** until the propagation and collector evidence lands.

### Request → worker propagation (OB10; OB8's worker half) (2026-10-07)
- **Schema:** migration `20261007120000_trace_context` adds nullable `traceparent TEXT` (with a CHECK of at most 128 chars) to `outbox_event` and `file_object`. It's expand-only: no backfill, and old rows stay null. `rls:check` passes (14 tables). The app role gets no new UPDATE grant on `outbox_event.traceparent`, so the value is written once, on insert.
- **Writes, in the business transaction:**
  - `Outbox.enqueueEmail` writes `traceparent: currentTraceparent()` with the row;
  - `FilesService.complete` writes it in the same update that sets `UPLOADED`.
  - With tracing off there's no valid span, and the value is null.
- **The format is W3C itself, not the global propagator** (`propagation.ts`), so what's stored or read never depends on what's registered. Unit tests (`propagation.spec.ts`) caught this when the registry was empty.
- **Outbox:** `outbox.deliver` is a `CONSUMER` span whose parent is the stored context, so request → delivery → send is one trace. It carries `tenant.id`, the event id and type, and the outcome. Null or malformed values give a fresh root, and a malformed one warns `outbox.traceparent_malformed` once per row, without logging the value.
- **File scans:** `files.scan` is a new root with a **link** to the stored context. `LinkAwareSampler` (wrapping `ParentBased(TraceIdRatio)`) samples a parentless, linked span exactly when its link was sampled. A malformed value gives an unlinked root and `files.scan.traceparent_malformed` once.
- **Pass spans:** `outbox.pass`, `files.scan.pass` and `keys.sweep.pass` carry `univarse.claimed`.
  - **Idle passes still emit a span (a deliberate choice).** Without it, each pass's claim queries would become their own root traces from the pg and Prisma instrumentations, so skipping idle passes would add noise, not remove it.
  - **Volume:** at most one root per loop per `WORKER_POLL_MS`, sampled at the root ratio (10% in production).
  - Revisit with metrics, which are out of scope here.
- **Bug found by the OB8 worker test, and fixed:**
  - **The bug:** the per-tenant `withLogContext` inside a pass tagged the *pass* span with `tenant.id`, and the last tenant won.
  - **The fix:** per-tenant contexts in a pass now pass `span: undefined`, and only the row spans carry a tenant.
- **Tests:**
  - **`propagation.spec.ts` (4, unit):**
    - null, valid and malformed stored values, including all-zero ids and over-long input;
    - links only for valid values;
    - the sampler follows a link either way and defers otherwise.
  - **`propagation.int.spec.ts` (8, real API and worker modules in process):**
    - **OB10 outbox, child span:** a reset request's row stores its `traceparent`. `outbox.deliver` is a CONSUMER child whose parent is the stored span and whose ancestry reaches the request root. The send runs inside that span with the tenant's log context.
    - **OB10 outbox, unsampled:** an unsampled request (`-00`) stores `-00`; the email is sent; no span of that trace and no delivery span is exported.
    - **OB10 outbox, old and malformed rows:** null and malformed rows both deliver under parentless roots, with exactly one warning that names the row, not the value.
    - **OB10 outbox, pass span:** `outbox.pass` is a root, with its claim work beneath it.
    - **OB8 worker half:** reset requests for tenants A, B, A, B, then **one** `runOnce()`. Every send ran under its own tenant's log context and its own request's trace (4 distinct traces), and the pass carries no tenant.
    - **OB10 scan, linked root:** complete stores its `traceparent`. `files.scan` is a parentless root in a new trace, linked to exactly that span, with `tenant.id` and outcome `clean`.
    - **OB10 scan, unsampled:** an unsampled upload leaves no `files.scan` span exported, and the file is still `CLEAN`.
    - **OB10 scan, malformed:** an unlinked root, one warning, and the file is still `CLEAN`.
- **Mutation checks:** each mutation was applied alone and the int file re-run; every one failed it.

  | Mutation | Failing tests |
  |---|---|
  | M1 enqueue writes no `traceparent` | 4/8 |
  | M2 delivery ignores the stored parent | 4/8 |
  | M3 `LinkAwareSampler` removed | 4/8 |
  | M4 scan parented instead of linked | 5/8 |
  | M5 pass span tagged per tenant (the bug above) | 3/8 |
  | M6 no per-row log context | 4/8 |
  | M7 complete writes no `traceparent` | 4/8 |
  | M8 malformed value not warned | 1/8 |
- **Counts (local, 2026-10-07):** API unit 154 (150 + 4); API integration 342 passed, 1 skipped (334 + 8). Lint and typecheck are clean. CI counts are recorded with the PR.
- **Not yet covered:**
  - OB12 (separate compiled processes against a real collector in CI). In-process tests share one provider, so they can't show the API → worker hop across processes; OB12 does.

### Collector failure (OB11) (2026-10-07)
- **The export gate (`BoundedExportProcessor`, `tracing.ts`):**
  - **The SDK's behaviour:** its `BatchSpanProcessor` drops overflow silently, with only a diag `debug` line.
  - **What the gate adds:** it wraps the SDK processor and enforces the same `maxQueueSize` itself. It counts `queued`, `maxQueued`, `dropped`, `failed` and `exported`.
  - **How `queued` is tracked:** it rises when a span is forwarded and falls when the processor hands the span to the exporter, so it mirrors the SDK buffer exactly.
  - **Reporting:** drops and failed exports go through one callback, rate-limited to one call per `EXPORT_WARN_EVERY_MS` (60 s). Each report carries the counts since the previous one.
  - **Where reports go:** `otel.ts` logs each report as a `warn` event, `otel.export_degraded`, on the process's own JSON stream. The report runs outside any trace context.
  - **Failure isolation:** a throwing reporter never breaks span processing.
- **Shutdown:**
  - `Tracing.shutdown()` races the provider's shutdown against `SHUTDOWN_FLUSH_MS` (5 s). It's memoised, so a repeated signal shares one bounded shutdown.
  - `main.ts` and `worker.ts` pass `onShutdown: shutdownTracing` to `AppModule`/`WorkerModule`. The modules register it as a Nest `onApplicationShutdown` hook (`shutdown-hook.ts`).
  - That hook runs after the server and connections close, so the last spans have ended before the flush.
  - Tests don't pass the hook, so closing a test app never stops the test process's tracing.
- **Tests:**
  - **`export-gate.spec.ts` (5, unit, fake exporters):**
    - a stalled exporter: 500 spans, the queue peaks at its bound of 10, more than 400 dropped, exactly one report;
    - a refusing exporter: failures counted; the second report is held until the window passes, then carries the remainder, with nothing lost;
    - healthy: nothing dropped or reported, and unsampled spans never queued;
    - a throwing reporter;
    - nothing queued after shutdown.
  - **`collector.int.spec.ts` (5):** the real OTLP/HTTP exporter and the gate, against a collector the test controls on one port. Bounds are queue 200, batch 20 and export timeout 3 s; the flush deadline is 1 s. Local run, 2026-10-07:

    | Phase | Request median (20 authenticated requests) | Email journey | Queue / counters | Warnings |
    |---|---|---|---|---|
    | Healthy (baseline) | 27.9 ms | 99.8 ms | dropped 0, failed 0 | none |
    | Stalled (accepts, never answers) | 24.8 / 26.2 ms | 47.3 ms | peaked at **200** (the bound), 1,881 dropped | **one** |
    | Unavailable (refused) | 24.8 ms | 39.4 ms | failures counted | no further warning in the window |

    - **The latency check:** each degraded median must be under `1.5 × baseline + 75 ms`. That's far below the 3 s export timeout a request waiting on export would show.
    - **Shutdown with a full queue and a stalled collector** took **1,009 ms** against the 1,000 ms deadline. The test asserts it lands between deadline − 100 and deadline + 250 ms. Because the export timeout (3 s) is longer than the deadline, the deadline is what ended it. A second call returns at once.
    - **The shutdown hooks:** closing an app made with `onShutdown` and a worker context made with it calls each hook exactly once. `main.ts` and `worker.ts` are checked to pass `shutdownTracing`.
- **Mutation checks:** each mutation was applied alone; each failed the listed tests.

  | Mutation | Unit tests failed | Integration tests failed |
  |---|---|---|
  | N1 gate doesn't enforce the bound | 2 | 3 |
  | N2 nothing reported | 2 | 2 |
  | N3 reports not rate-limited | 2 | 2 |
  | N4 shutdown without the deadline | none | 1 |
  | N5 failed exports not counted | 1 | 1 |
  | N6 `AppModule` drops the shutdown hook | none | 2 |
- **Compiled smoke (local):** `node --import ./dist/otel.js dist/worker.js` with `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at a closed port.
  - Every output line was JSON.
  - One `otel.export_degraded` warning appeared, with `failed` counted and `traceId: null`.
  - It takes about 7 to 20 s to appear: the OTLP exporter retries a refused connection with backoff for up to its 5 s timeout before reporting failure.
  - **Not verified locally:** graceful signal shutdown of the compiled processes. On Windows, `kill('SIGINT')` terminates without running handlers. OB12's Linux CI job covers it.
- **Counts (local, quiet stack, 2026-10-07):** API unit 159 (154 + 5). The full API integration run passed everything except tests needing ClamAV, which had been stopped mid-run (exit 143) to free memory. Those four files were re-run with ClamAV up: 132/132. The integration total is 347 + 1 skipped (342 + 5). CI counts will be recorded with the PR.
- **No-endpoint check still passes** after `otel.ts` changed (`no-export.int.spec.ts`: compiled API and worker, 0 export attempts).

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
