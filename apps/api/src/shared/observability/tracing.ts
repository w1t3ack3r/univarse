// Spec 0012 OB5/OB9/OB11: OpenTelemetry tracing for the API and worker. Started by `src/otel.ts` through
// `node --import` BEFORE any instrumented library loads (OB9); tests start it in-process.
import { context, propagation, trace, type Attributes, type AttributeValue } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
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
export const SHUTDOWN_FLUSH_MS = 5_000;

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
}

export interface Tracing {
  readonly provider: NodeTracerProvider;
  shutdown(): Promise<void>;
}

/** Starts tracing for this process. Call before importing anything instrumented. */
export function startTracing(opts: TracingOptions): Tracing {
  const exporter = opts.exporter ?? (opts.endpoint ? new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces`, timeoutMillis: EXPORT_BOUNDS.exportTimeoutMillis }) : undefined);
  const processors: SpanProcessor[] = [new SanitizingSpanProcessor(opts.onDropped)];
  if (exporter) processors.push(opts.processor ? opts.processor(exporter) : new BatchSpanProcessor(exporter, EXPORT_BOUNDS));

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

  return {
    provider,
    shutdown: () => Promise.race([provider.shutdown(), new Promise<void>((r) => setTimeout(r, SHUTDOWN_FLUSH_MS).unref())]),
  };
}

/** The active span, for attributes such as tenant.id and user.id (set as they're resolved). */
export const activeSpan = (): Span | undefined => trace.getSpan(context.active()) as Span | undefined;
