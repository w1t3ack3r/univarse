// Spec 0012 OB11: the export gate keeps the span queue bounded, counts what it drops and what fails to
// export, and reports it at most once per window. Fake exporters stand in for stalled and refusing collectors;
// the integration test (collector.int.spec.ts) drives the real OTLP exporter and the app.
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { BoundedExportProcessor, EXPORT_WARN_EVERY_MS, type ExportDegraded } from './tracing.js';

const bounds = { maxQueueSize: 10, maxExportBatchSize: 5, scheduledDelayMillis: 5, exportTimeoutMillis: 50 };
const span = (sampled = true) =>
  ({ spanContext: () => ({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: sampled ? 1 : 0 }), resource: { asyncAttributesPending: false } }) as unknown as ReadableSpan;
const exporter = (answer: ((done: (r: ExportResult) => void) => void) | null): SpanExporter & { calls: number } => {
  const e = {
    calls: 0,
    export(_spans: ReadableSpan[], done: (r: ExportResult) => void) {
      e.calls++;
      answer?.(done);
    },
    shutdown: () => Promise.resolve(),
  };
  return e;
};
const stalled = () => exporter(null); // accepts, never answers
const refusing = () => exporter((done) => done({ code: ExportResultCode.FAILED, error: new Error('connect ECONNREFUSED') }));
const healthy = () => exporter((done) => done({ code: ExportResultCode.SUCCESS }));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('[OB11] the export gate', () => {
  it('[OB11] stalled collector: the queue never passes its bound; overflow is dropped, counted and reported ONCE', async () => {
    const reports: ExportDegraded[] = [];
    const gate = new BoundedExportProcessor(stalled(), bounds, (d) => reports.push(d));
    let peak = 0;
    for (let i = 0; i < 500; i++) {
      gate.onEnd(span());
      peak = Math.max(peak, gate.stats.queued);
      if (i % 50 === 0) await tick(10); // let batches leave for the (stalled) exporter
    }
    expect(peak).toBeLessThanOrEqual(bounds.maxQueueSize);
    expect(gate.stats.maxQueued).toBeLessThanOrEqual(bounds.maxQueueSize);
    expect(gate.stats.dropped).toBeGreaterThan(400);
    expect(gate.stats.dropped + gate.stats.queued + gate.stats.exported + gate.stats.failed).toBeLessThanOrEqual(500);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ maxQueueSize: 10 });
    expect(reports[0]!.dropped).toBeGreaterThan(0);
  });

  it('[OB11] refusing collector: failed exports are counted; reports are rate-limited and carry counts since the last one', async () => {
    let now = 1_000_000;
    const reports: ExportDegraded[] = [];
    const gate = new BoundedExportProcessor(refusing(), bounds, (d) => reports.push(d), EXPORT_WARN_EVERY_MS, () => now);
    for (let i = 0; i < 8; i++) gate.onEnd(span());
    await gate.forceFlush().catch(() => undefined);
    expect(gate.stats.failed).toBe(8);
    expect(gate.stats.queued).toBe(0);
    expect(reports).toHaveLength(1); // the first failure reports; the rest wait for the window
    now += EXPORT_WARN_EVERY_MS - 1;
    for (let i = 0; i < 4; i++) gate.onEnd(span());
    await gate.forceFlush().catch(() => undefined);
    expect(reports).toHaveLength(1);
    now += 1;
    gate.onEnd(span());
    await gate.forceFlush().catch(() => undefined);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.failed + reports[0]!.failed).toBe(gate.stats.failed); // nothing lost between reports
  });

  it('[OB11] a healthy collector: nothing dropped, nothing reported; unsampled spans never enter the queue', async () => {
    const reports: ExportDegraded[] = [];
    const e = healthy();
    const gate = new BoundedExportProcessor(e, bounds, (d) => reports.push(d));
    for (let i = 0; i < 9; i++) gate.onEnd(span());
    for (let i = 0; i < 100; i++) gate.onEnd(span(false));
    await gate.forceFlush();
    expect(gate.stats).toMatchObject({ queued: 0, dropped: 0, failed: 0, exported: 9 });
    expect(reports).toEqual([]);
  });

  it('[OB11] a throwing reporter never breaks span processing', () => {
    const gate = new BoundedExportProcessor(stalled(), bounds, () => {
      throw new Error('logger down');
    });
    expect(() => {
      for (let i = 0; i < 50; i++) gate.onEnd(span());
    }).not.toThrow();
    expect(gate.stats.dropped).toBeGreaterThan(0);
  });

  it('[OB11] after shutdown nothing is queued', async () => {
    const gate = new BoundedExportProcessor(healthy(), bounds);
    await gate.shutdown();
    gate.onEnd(span());
    expect(gate.stats.queued).toBe(0);
  });
});

describe('[OB11] export bounds from the standard OTEL_BSP_* variables', () => {
  it('[OB11] unset (production): exactly EXPORT_BOUNDS', async () => {
    const { EXPORT_BOUNDS, exportBoundsFromEnv } = await import('./tracing.js');
    expect(exportBoundsFromEnv({})).toEqual(EXPORT_BOUNDS);
  });

  it('[OB11] positive integers override one bound each; anything else is ignored; a batch never exceeds the queue', async () => {
    const { EXPORT_BOUNDS, exportBoundsFromEnv } = await import('./tracing.js');
    expect(exportBoundsFromEnv({ OTEL_BSP_SCHEDULE_DELAY: '600000', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '50000', OTEL_BSP_MAX_QUEUE_SIZE: '100000' })).toEqual({
      ...EXPORT_BOUNDS,
      scheduledDelayMillis: 600_000,
      maxExportBatchSize: 50_000,
      maxQueueSize: 100_000,
    });
    for (const bad of ['', '0', '-5', '1.5', 'abc', '1e400']) expect(exportBoundsFromEnv({ OTEL_BSP_SCHEDULE_DELAY: bad }), bad).toEqual(EXPORT_BOUNDS);
    expect(exportBoundsFromEnv({ OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '9999' }).maxExportBatchSize).toBe(EXPORT_BOUNDS.maxQueueSize);
  });
});
