// Spec 0012 OB10 (D3, D4): carrying a request's trace context to the work the worker does later. The
// request writes its W3C `traceparent` into the business row, in the same transaction; the worker turns it
// back into a parent (outbox delivery: one trace) or a link (file scan: its own trace, navigable from the
// upload). The sampled flag travels with it, so the worker keeps the request's sampling decision.
import { context, defaultTextMapGetter, defaultTextMapSetter, ROOT_CONTEXT, trace, TraceFlags, type Context, type Link, type SpanContext } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { SamplingDecision, type Sampler, type SamplingResult } from '@opentelemetry/sdk-trace-base';

// The W3C format itself, not the global propagator: what is stored must not depend on what is registered.
const w3c = new W3CTraceContextPropagator();

/** The active request's context as a `traceparent`, or null when there's no valid span (tracing off). */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  w3c.inject(context.active(), carrier, defaultTextMapSetter);
  return carrier.traceparent ?? null;
}

export type StoredContext =
  | { readonly kind: 'none' } // null: written before this release, or with tracing off
  | { readonly kind: 'malformed' } // not a valid W3C traceparent: treated as none (logged once)
  | { readonly kind: 'valid'; readonly spanContext: SpanContext; readonly context: Context };

/** A stored `traceparent`, read back. Malformed or missing values never fail the work. */
export function storedContext(traceparent: string | null | undefined): StoredContext {
  if (!traceparent) return { kind: 'none' };
  const extracted = w3c.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
  const sc = trace.getSpanContext(extracted);
  return sc && trace.isSpanContextValid(sc) ? { kind: 'valid', spanContext: sc, context: extracted } : { kind: 'malformed' };
}

/** A span link to a stored context (file scans link to their upload). */
export const linkTo = (stored: StoredContext): Link[] => (stored.kind === 'valid' ? [{ context: stored.spanContext }] : []);

/**
 * D3: a span with no parent but a link (a file scan) is sampled exactly when the linked span was; anything
 * else goes to the configured sampler (parent-based, ratio at the root).
 */
export class LinkAwareSampler implements Sampler {
  constructor(private readonly fallback: Sampler) {}

  shouldSample(ctx: Context, traceId: string, name: string, kind: Parameters<Sampler['shouldSample']>[3], attributes: Parameters<Sampler['shouldSample']>[4], links: Link[]): SamplingResult {
    const parent = trace.getSpanContext(ctx);
    const [link] = links;
    if (!(parent && trace.isSpanContextValid(parent)) && link) {
      const sampled = (link.context.traceFlags & TraceFlags.SAMPLED) !== 0;
      return { decision: sampled ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
    }
    return this.fallback.shouldSample(ctx, traceId, name, kind, attributes, links);
  }

  toString(): string {
    return `LinkAwareSampler{${this.fallback.toString()}}`;
  }
}
