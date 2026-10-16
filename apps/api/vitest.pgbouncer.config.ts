import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Spec 0017 PB7's API probe: it needs PgBouncer up in the probe profile and the app's URLs pointed at it.
// Not part of test:int; run by the pgbouncer-isolation CI job (and `pnpm test:int:pgbouncer`).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.probe.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
