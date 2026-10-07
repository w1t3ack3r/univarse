// Spec 0012 OB5 (span sanitizing), OB7 (security logs are never sampled), OB11 (export bounds).
// Tracing is started here with ratio 0: every root span is DROPPED by the sampler.
import { Writable } from 'node:stream';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { securityFields } from './security.js';
import { EXPORT_BOUNDS, isAllowedAttribute, SanitizingSpanProcessor, sanitizeStatement, SHUTDOWN_FLUSH_MS, startTracing } from './tracing.js';

const exporter = new InMemorySpanExporter();
startTracing({ service: 'api', env: 'test', version: 'test', ratio: 0, exporter, processor: (e) => new SimpleSpanProcessor(e) });

/** A finished span shaped like the SDK's, for the processor alone. */
const fakeSpan = (attributes: Record<string, unknown>, events: { name: string; attributes?: Record<string, unknown> }[] = []) =>
  ({ attributes, events }) as unknown as ReadableSpan;

describe('[OB5] spans are sanitized before any exporter sees them', () => {
  it('[OB5] attributes off the allowlist are removed, each reported once', () => {
    const dropped: string[] = [];
    const p = new SanitizingSpanProcessor((k) => dropped.push(k));
    const a = { 'http.route': '/api/v1/files/:id', 'http.request.header.cookie': ['x'], 'db.connection_string': 'postgresql://u:p@h/db', 'tenant.id': 't' };
    p.onEnd(fakeSpan(a));
    p.onEnd(fakeSpan({ 'http.request.header.cookie': ['y'] }));
    expect(a).toEqual({ 'http.route': '/api/v1/files/:id', 'tenant.id': 't' });
    expect(dropped).toEqual(['http.request.header.cookie', 'db.connection_string']);
  });

  it('[OB5] headers, query and connection strings are never allowed; route, method and status are', () => {
    for (const k of ['http.request.header.authorization', 'http.response.header.set-cookie', 'url.query', 'url.full', 'db.connection_string', 'db.statement.parameters', 'baggage']) expect(isAllowedAttribute(k), k).toBe(false);
    for (const k of ['http.route', 'http.request.method', 'http.response.status_code', 'db.query.text', 'tenant.id', 'user.id', 'request.id']) expect(isAllowedAttribute(k), k).toBe(true);
  });

  it('[OB5] SQL keeps its shape, never its values: quoted and numeric literals become ?, $n placeholders stay', () => {
    expect(sanitizeStatement("SELECT * FROM user_account WHERE email = 'ada@uni.ng' AND failed > 3 AND id = $1 LIMIT 10")).toBe(
      'SELECT * FROM user_account WHERE email = ? AND failed > ? AND id = $1 LIMIT ?',
    );
    const a = { 'db.query.text': "UPDATE session SET token_hash = 'deadbeef' WHERE id = $2" };
    new SanitizingSpanProcessor().onEnd(fakeSpan(a));
    expect(a['db.query.text']).toBe('UPDATE session SET token_hash = ? WHERE id = $2');
  });

  it('[OB5] allowed string values are scrubbed (query strings, cookie values, signed credentials)', () => {
    const a = { 'url.path': '/api/v1/files?token=abc', 'univarse.detail': 'cookie __Host-uv_sid=SESSION and X-Amz-Credential=AKIA/x' };
    new SanitizingSpanProcessor().onEnd(fakeSpan(a));
    expect(a).toEqual({ 'url.path': '/api/v1/files', 'univarse.detail': 'cookie __Host-uv_sid=[redacted] and X-Amz-Credential=[redacted]' });
  });

  it('[OB5] exception events keep the type and a scrubbed message; stacks and anything else are removed', () => {
    const ev = { name: 'exception', attributes: { 'exception.type': 'PrismaClientKnownRequestError', 'exception.message': "Key (email)=('ada@uni.ng') exists", 'exception.stacktrace': 'Error: …\n    at x', other: 'v' } };
    new SanitizingSpanProcessor().onEnd(fakeSpan({}, [ev]));
    expect(ev.attributes).toEqual({ 'exception.type': 'PrismaClientKnownRequestError', 'exception.message': "Key (email)=('?') exists" });
  });
});

describe('[OB7] security logs are never sampled', () => {
  it('[OB7] a security event inside a span the sampler DROPPED is still logged, carrying that trace id', () => {
    const lines: Record<string, unknown>[] = [];
    const log = createLogger({
      service: 'api',
      env: 'test',
      version: 'test',
      destination: new Writable({
        write(c: Buffer, _e, done) {
          lines.push(JSON.parse(c.toString()) as Record<string, unknown>);
          done();
        },
      }),
    });
    exporter.reset();
    const tracer = trace.getTracer('test');
    let traceId = '';
    tracer.startActiveSpan('dropped-by-the-sampler', (span) => {
      expect(span.isRecording()).toBe(false); // ratio 0: not sampled
      traceId = span.spanContext().traceId;
      log.warn(securityFields('auth.account.locked', { lockedUserId: 'u-1' }), 'Account locked after repeated failures');
      span.end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'auth.account.locked', stream: 'security', level: 'warn', traceId });
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('[OB11] export bounds are configured', () => {
  it('[OB11] the batch processor is bounded, with an export timeout and a shutdown flush deadline', () => {
    expect(EXPORT_BOUNDS).toEqual({ maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 2_000, exportTimeoutMillis: 5_000 });
    expect(SHUTDOWN_FLUSH_MS).toBe(5_000);
  });
});
