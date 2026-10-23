import { defineConfig } from 'vitest/config';

// Spec 0020 (the bucket copy's fix): the shred ledger's bucket copy against the stack's own SeaweedFS (Docker, or
// SEAWEEDFS_BIN), `pnpm --filter @univarse/stack test:bucket`. Its runs share one data volume, in order.
export default defineConfig({ test: { include: ['src/bucket.int.ts'], testTimeout: 300_000, hookTimeout: 120_000, fileParallelism: false, sequence: { concurrent: false } } });
