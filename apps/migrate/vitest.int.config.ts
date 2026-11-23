import { defineConfig } from 'vitest/config';

// Spec 0039: the per-shard runner against the development databases (the migrator, which may create databases in
// development). One file at a time: each test makes and drops its own scratch database.
export default defineConfig({
  test: {
    include: ['src/**/*.int.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
