import { defineConfig } from 'vitest/config';

// Spec 0019 B6: the stack's isolation probe, run only by `pnpm stack:isolation` (it needs the tunnel and STACK_DIR).
export default defineConfig({ test: { include: ['src/isolation.probe.ts'], testTimeout: 300_000, fileParallelism: false } });
