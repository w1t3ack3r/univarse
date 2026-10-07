// Spec 0012 OB5/OB9/OB11: OpenTelemetry tracing for the API and worker. Started by `src/otel.ts` through
// `node --import` BEFORE any instrumented library loads (OB9); tests start it in-process.
import { context, propagation, ROOT_CONTEXT, trace, TraceFlags, type Attributes, type AttributeValue, type Context } from '@opentelemetry/api';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Span as SdkSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { setActiveSpanIdsProvider } from './logger.js';
import { LinkAwareSampler } from './propagation.js';
import { scrub, scrubForeign } from './scrub.js';

/** OB11: the batch processor's bounds, and how long shutdown may spend flushing. */
export const EXPORT_BOUNDS = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 2_000,
  exportTimeoutMillis: 5_000,
} as const;
export type ExportBounds = { readonly [K in keyof typeof EXPORT_BOUNDS]: number };
export const SHUTDOWN_FLUSH_MS = 5_000;

/**
 * The standard OpenTelemetry `OTEL_BSP_*` variables, each overriding one bound when it is a positive integer.
 * Production sets none of them, so EXPORT_BOUNDS applies. The OB12 shutdown test sets a delay longer than the
 * test, so only the shutdown flush can export. (Explicit config makes the SDK ignore these variables; this
 * reads them for it, validated.)
 */
export function exportBoundsFromEnv(env: Record<string, string | undefined>): ExportBounds {
  const pick = (key: string, fallback: number) => {
    const raw = env[key];
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  const maxQueueSize = pick('OTEL_BSP_MAX_QUEUE_SIZE', EXPORT_BOUNDS.maxQueueSize);
  return {
    maxQueueSize,
    // A batch can't be larger than the queue (the SDK would cap it anyway).
    maxExportBatchSize: Math.min(pick('OTEL_BSP_MAX_EXPORT_BATCH_SIZE', EXPORT_BOUNDS.maxExportBatchSize), maxQueueSize),
    scheduledDelayMillis: pick('OTEL_BSP_SCHEDULE_DELAY', EXPORT_BOUNDS.scheduledDelayMillis),
    exportTimeoutMillis: pick('OTEL_BSP_EXPORT_TIMEOUT', EXPORT_BOUNDS.exportTimeoutMillis),
  };
}
/** OB11: at most one `otel.export_degraded` warning per window, carrying the counts since the last one. */
export const EXPORT_WARN_EVERY_MS = 60_000;

export interface ExportStats {
  /** Spans handed to the batch processor and not yet handed to the exporter. Never exceeds `maxQueueSize`. */
  queued: number;
  /** The most `queued` ever reached. */
  maxQueued: number;
  /** Dropped because the queue was full. */
  dropped: number;
  /** Handed to the exporter, which reported failure (refused, timed out, rejected). */
  failed: number;
  exported: number;
}
export interface ExportDegraded {
  readonly dropped: number;
  readonly failed: number;
  readonly maxQueueSize: number;
}

/**
 * OB11: the SDK's batch processor, with its queue bound enforced and COUNTED here. The SDK drops overflow
 * silently (a diag debug line); this gate drops it first, counts it, and reports drops and failed exports
 * through one rate-limited callback. `queued` mirrors the batch processor's buffer exactly: spans in when
 * forwarded, out when the processor hands them to the exporter. Requests never wait on export either way.
 */
export class BoundedExportProcessor implements SpanProcessor {
  readonly stats: ExportStats = { queued: 0, maxQueued: 0, dropped: 0, failed: 0, exported: 0 };
  private readonly batch: BatchSpanProcessor;
  private pending = { dropped: 0, failed: 0 };
  private lastWarn = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(
    exporter: SpanExporter,
    private readonly bounds: ExportBounds,
    private readonly onDegraded: (d: ExportDegraded) => void = () => undefined,
    private readonly warnEveryMs = EXPORT_WARN_EVERY_MS,
    private readonly now: () => number = Date.now,
  ) {
    const counting: SpanExporter = {
      export: (spans, done) => {
        this.stats.queued -= spans.length;
        exporter.export(spans, (result) => {
          if (result.code === ExportResultCode.SUCCESS) this.stats.exported += spans.length;
          else this.note('failed', spans.length);
          done(result);
        });
      },
      shutdown: () => exporter.shutdown(),
      forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
    };
    this.batch = new BatchSpanProcessor(counting, { ...bounds });
  }

  onStart(span: SdkSpan, parent: Context): void {
    this.batch.onStart(span, parent);
  }

  onEnd(span: ReadableSpan): void {
    // As the batch processor: unsampled spans, and anything after shutdown, are never queued.
    if (this.closed || (span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
    if (this.stats.queued >= this.bounds.maxQueueSize) {
      this.note('dropped', 1);
      return;
    }
    this.stats.queued++;
    if (this.stats.queued > this.stats.maxQueued) this.stats.maxQueued = this.stats.queued;
    this.batch.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.batch.forceFlush();
  }

  shutdown(): Promise<void> {
    this.closed = true;
    return this.batch.shutdown();
  }

  private note(kind: 'dropped' | 'failed', n: number): void {
    this.stats[kind] += n;
    this.pending[kind] += n;
    const t = this.now();
    if (t - this.lastWarn < this.warnEveryMs) return;
    this.lastWarn = t;
    const report = { ...this.pending, maxQueueSize: this.bounds.maxQueueSize };
    this.pending = { dropped: 0, failed: 0 };
    try {
      // Outside any trace: the report is about the exporter, not whichever span happened to be active.
      context.with(ROOT_CONTEXT, () => this.onDegraded(report));
    } catch {
      // Reporting must never break span processing.
    }
  }
}

/** OB5: the only span attributes that may leave the process. Anything else is removed and reported. */
const ALLOWED = new Set([
  // HTTP (route template, never headers or query)
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.path',
  'url.scheme',
  'server.address',
  'server.port',
  'network.protocol.version',
  'network.peer.address',
  'network.peer.port',
  'user_agent.original',
  // Databases (statements without values)
  'db.system',
  'db.system.name',
  'db.namespace',
  'db.name',
  'db.statement',
  'db.query.text',
  'db.operation',
  'db.operation.name',
  'db.collection.name',
  'net.peer.name',
  'net.peer.port',
  // Ours
  'tenant.id',
  'user.id',
  'request.id',
]);
const ALLOWED_PREFIXES = ['fastify.', 'hook.', 'prisma.', 'univarse.'];
const STATEMENT_KEYS = new Set(['db.statement', 'db.query.text']);
const NUMBER_LITERAL = /\b\d+(\.\d+)?\b/g;

export const isAllowedAttribute = (key: string): boolean => ALLOWED.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p));

/** SQL statements keep their shape, never their values: quoted and numeric literals become `?`. */
export const sanitizeStatement = (sql: string): string => scrubForeign(sql).replace(/'\?'/g, '?').replace(NUMBER_LITERAL, (m, _f, i: number, s: string) => (s[i - 1] === '$' ? m : '?'));

function sanitizeValue(key: string, value: AttributeValue): AttributeValue {
  if (typeof value !== 'string') return value;
  if (STATEMENT_KEYS.has(key)) return sanitizeStatement(value);
  return scrub(value);
}

/**
 * OB5: runs at span end, before any exporter sees the span. Removes attributes that aren't allowed
 * (reporting each key once), sanitizes the rest, drops query strings, and scrubs exception events.
 */
export class SanitizingSpanProcessor implements SpanProcessor {
  private readonly reported = new Set<string>();
  constructor(private readonly onDropped: (key: string) => void = () => undefined) {}

  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    // The SDK's finished-span attributes are mutable here, before export; that's this processor's job.
    const attrs: Attributes = span.attributes;
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (!isAllowedAttribute(key) || value === undefined) {
        Reflect.deleteProperty(attrs, key);
        if (!this.reported.has(key)) {
          this.reported.add(key);
          this.onDropped(key);
        }
        continue;
      }
      attrs[key] = sanitizeValue(key, value);
    }
    for (const event of span.events) {
      const ea: Attributes | undefined = event.attributes;
      if (!ea) continue;
      for (const key of Object.keys(ea)) {
        if (key === 'exception.type') continue;
        if (key === 'exception.message' && typeof ea[key] === 'string') ea[key] = scrubForeign(ea[key]);
        else Reflect.deleteProperty(ea, key); // stack traces and anything else on events never leave
      }
    }
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface TracingOptions {
  readonly service: 'api' | 'worker';
  readonly env: string;
  readonly version: string;
  /** OTLP/HTTP endpoint; with none and no `exporter`, nothing is exported (OB11). */
  readonly endpoint?: string | undefined;
  /** Root sampling ratio (D3). Children follow their parent. */
  readonly ratio: number;
  /** Tests: an in-memory exporter, and processors of their choosing. */
  readonly exporter?: SpanExporter;
  readonly processor?: (exporter: SpanExporter) => SpanProcessor;
  readonly onDropped?: (key: string) => void;
  /** OB11: export trouble (drops, failed exports), at most once per `warnEveryMs`. */
  readonly onExportDegraded?: ((d: ExportDegraded) => void) | undefined;
  /** Tests only: smaller bounds and deadlines, to reach them quickly. */
  readonly bounds?: ExportBounds | undefined;
  readonly shutdownFlushMs?: number | undefined;
  readonly warnEveryMs?: number | undefined;
}

export interface Tracing {
  readonly provider: NodeTracerProvider;
  /** The export gate's counters, when exporting over OTLP (OB11). */
  readonly export: BoundedExportProcessor | undefined;
  /** Flushes what it can and stops; never takes longer than the flush deadline (OB11). */
  shutdown(): Promise<void>;
}

let current: Tracing | undefined;
/** Shuts down this process's tracing, if started. Process shutdown calls it last (OB11). */
export const shutdownTracing = (): Promise<void> => current?.shutdown() ?? Promise.resolve();

/** Starts tracing for this process. Call before importing anything instrumented. */
export function startTracing(opts: TracingOptions): Tracing {
  const bounds = opts.bounds ?? EXPORT_BOUNDS;
  const exporter = opts.exporter ?? (opts.endpoint ? new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces`, timeoutMillis: bounds.exportTimeoutMillis }) : undefined);
  const processors: SpanProcessor[] = [new SanitizingSpanProcessor(opts.onDropped)];
  let gate: BoundedExportProcessor | undefined;
  if (exporter && opts.processor) processors.push(opts.processor(exporter));
  else if (exporter) processors.push((gate = new BoundedExportProcessor(exporter, bounds, opts.onExportDegraded, opts.warnEveryMs)));

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.service, [ATTR_SERVICE_VERSION]: opts.version, 'deployment.environment.name': opts.env }),
    // D3: parent-based with a ratio at the root; a linked root (a file scan) follows its link (OB10).
    sampler: new LinkAwareSampler(new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(opts.ratio) })),
    spanProcessors: processors,
  });
  // OB8: W3C trace context only. Baggage isn't propagated or read: it can't carry tenant or identity.
  provider.register({ propagator: new W3CTraceContextPropagator() });
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new HttpInstrumentation({
        headersToSpanAttributes: { client: { requestHeaders: [], responseHeaders: [] }, server: { requestHeaders: [], responseHeaders: [] } },
        // OB9: the server span is named by method + route TEMPLATE, recorded on the raw request by onRequest.
        applyCustomAttributesOnSpan: (span, request) => {
          const route = (request as { univarseRoute?: string | null }).univarseRoute;
          const method = (request as { method?: string }).method;
          if (route && method) {
            span.updateName(`${method} ${route}`);
            span.setAttribute('http.route', route);
          }
        },
      }),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // OB5: the command name only, never its arguments, keys or values.
      new IORedisInstrumentation({ dbStatementSerializer: (cmd) => cmd }),
      new PrismaInstrumentation(),
    ],
  });

  setActiveSpanIdsProvider(() => {
    const span = trace.getSpan(context.active());
    const ctx = span?.spanContext();
    return ctx && trace.isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : { traceId: null, spanId: null };
  });

  const flushMs = opts.shutdownFlushMs ?? SHUTDOWN_FLUSH_MS;
  let stopping: Promise<void> | undefined;
  current = {
    provider,
    export: gate,
    // A stalled collector must not hold the process: whatever isn't exported by the deadline is abandoned.
    shutdown: () =>
      (stopping ??= Promise.race([
        provider.shutdown().catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, flushMs).unref()),
      ])),
  };
  return current;
}

/** The active span, for attributes such as tenant.id and user.id (set as they're resolved). */
export const activeSpan = (): Span | undefined => trace.getSpan(context.active()) as Span | undefined;
