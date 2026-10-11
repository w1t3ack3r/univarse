// Spec 0012 OB10 (D3, D4): reading stored trace contexts back, and the sampling rule for linked roots.
import { randomBytes } from 'node:crypto';
import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from '@opentelemetry/api';
import { AlwaysOffSampler, AlwaysOnSampler, SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { linkTo, LinkAwareSampler, storedContext } from './propagation.js';

const hex = (n: number) => randomBytes(n).toString('hex');
const tp = (flags: '00' | '01') => `00-${hex(16)}-${hex(8)}-${flags}`;

describe('[OB10] stored trace contexts', () => {
  it('[OB10] null/empty is none; a W3C value is valid with its flags; anything else is malformed, never a throw', () => {
    expect(storedContext(null).kind).toBe('none');
    expect(storedContext('').kind).toBe('none');
    const v = tp('01');
    const s = storedContext(v);
    expect(s.kind).toBe('valid');
    if (s.kind !== 'valid') throw new Error('unreachable');
    expect(s.spanContext.traceId).toBe(v.split('-')[1]);
    expect(s.spanContext.traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
    expect(trace.getSpanContext(s.context)?.isRemote).toBe(true);
    for (const bad of ['garbage', `00-${'0'.repeat(32)}-${hex(8)}-01`, `00-${hex(16)}-${'0'.repeat(16)}-01`, `00-${hex(15)}-${hex(8)}-01`, 'x'.repeat(128)]) {
      expect(storedContext(bad).kind, bad).toBe('malformed');
    }
  });

  it('[OB10] a link exists only for a valid context', () => {
    expect(linkTo(storedContext(null))).toEqual([]);
    expect(linkTo(storedContext('garbage'))).toEqual([]);
    expect(linkTo(storedContext(tp('00')))).toHaveLength(1);
  });
});

describe('[OB10][OB7] LinkAwareSampler: a parentless linked span follows its link', () => {
  const link = (flags: '00' | '01') => linkTo(storedContext(tp(flags)));
  const decide = (fallback: AlwaysOnSampler | AlwaysOffSampler, ctx = ROOT_CONTEXT, links = link('01')) =>
    new LinkAwareSampler(fallback).shouldSample(ctx, hex(16), 'files.scan', SpanKind.INTERNAL, {}, links).decision;

  it('[OB10] sampled link → sampled, even when the ratio would drop it; unsampled link → dropped, even when it would keep it', () => {
    expect(decide(new AlwaysOffSampler(), ROOT_CONTEXT, link('01'))).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(decide(new AlwaysOnSampler(), ROOT_CONTEXT, link('00'))).toBe(SamplingDecision.NOT_RECORD);
  });

  it('[OB10] no links, or a valid parent: the configured sampler decides', () => {
    expect(decide(new AlwaysOffSampler(), ROOT_CONTEXT, [])).toBe(SamplingDecision.NOT_RECORD);
    expect(decide(new AlwaysOnSampler(), ROOT_CONTEXT, [])).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    const parent = storedContext(tp('01'));
    if (parent.kind !== 'valid') throw new Error('unreachable');
    expect(decide(new AlwaysOffSampler(), parent.context, link('01'))).toBe(SamplingDecision.NOT_RECORD);
  });
});
