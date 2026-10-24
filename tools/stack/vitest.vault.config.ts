import { defineConfig } from 'vitest/config';

// Spec 0020 B-4 (BK5's first half): Vault's migration to Raft against the stack's pinned image, on volumes of its own,
// `pnpm --filter @univarse/stack test:vault` (CI). Its cases share one Vault, in order.
export default defineConfig({ test: { include: ['src/vault-raft.int.ts'], testTimeout: 300_000, hookTimeout: 180_000, fileParallelism: false, sequence: { concurrent: false } } });
