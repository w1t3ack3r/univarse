// Spec 0012 OB10: spans for worker passes and claimed rows. Errors are recorded (type and a scrubbed
// message, by the sanitizer) and rethrown; the span always ends.
import { SpanStatusCode, trace, type Context, type Span, type SpanOptions } from '@opentelemetry/api';

const tracer = () => trace.getTracer('univarse.worker');

export function withSpan<T>(name: string, options: SpanOptions, parent: Context, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, options, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Warns once per row id that a stored traceparent was malformed (bounded memory). */
export class MalformedOnce {
  private readonly seen = new Set<string>();
  first(id: string): boolean {
    if (this.seen.has(id)) return false;
    if (this.seen.size > 10_000) this.seen.clear();
    this.seen.add(id);
    return true;
  }
}
