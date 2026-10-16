import { defineConfig } from 'vitest/config';

// Spec 0017's pooling probes: they need PgBouncer up in the probe profile (tools/pgbouncer/run.mjs start probe).
// Not part of test:int; run by `pnpm test:int:pgbouncer` and the pgbouncer-isolation CI job.
export default defineConfig({
  test: {
    include: ['test/**/*.probe.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
