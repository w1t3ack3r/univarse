// Spec 0012: tracing for in-process tests. Call (and await) BEFORE importing anything instrumented —
// the harness, the app, pg, ioredis — so the ESM hook and the instrumentations see those modules load.
import { createRequire, register } from 'node:module';
import { BatchSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createAddHookMessageChannel } from 'import-in-the-middle';
import type { Tracing } from '../shared/observability/tracing.js';

export interface TestTracing {
  readonly exporter: InMemorySpanExporter;
  readonly tracing: Tracing;
  /** Attribute keys the sanitizer removed (OB5), in order of first sight. */
  readonly dropped: string[];
  /** Exports everything ended so far; call before reading the exporter. */
  flush(): Promise<void>;
}

export async function startTestTracing(opts: { ratio?: number; service?: 'api' | 'worker' } = {}): Promise<TestTracing> {
  const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- import-in-the-middle's hook is an async loader; it needs `register` (registerHooks is synchronous, in-thread)
  register('import-in-the-middle/hook.mjs', import.meta.url, registerOptions);
  const { startTracing } = await import('../shared/observability/tracing.js');
  const exporter = new InMemorySpanExporter();
  const dropped: string[] = [];
  const tracing = startTracing({
    service: opts.service ?? 'api',
    env: 'test',
    version: 'test',
    ratio: opts.ratio ?? 1,
    exporter,
    // Batched, like production: synchronous per-span export slowed requests enough to hit Prisma's 2 s
    // transaction wait under concurrency (P2028). A short delay keeps tests quick; flush() before asserting.
    processor: (e) => new BatchSpanProcessor(e, { scheduledDelayMillis: 50, maxQueueSize: 100_000, maxExportBatchSize: 10_000 }),
    onDropped: (k) => dropped.push(k),
  });
  await waitForAllMessagesAcknowledged();
  // Vitest imports externals through its own loader, which the ioredis instrumentation doesn't see (pg,
  // reached through Prisma's adapter, is fine). Loading ioredis once through `require` patches it in Node's
  // CommonJS cache, which the app's later ES import reuses. The compiled processes need none of this (OB12).
  createRequire(import.meta.url)('ioredis');
  return { exporter, tracing, dropped, flush: () => tracing.provider.forceFlush() };
}
