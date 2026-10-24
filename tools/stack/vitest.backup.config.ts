import { defineConfig } from 'vitest/config';

// Spec 0020 PR B1's containers, `pnpm --filter @univarse/stack test:backup` (CI): Vault's migration to Raft (B-4, BK5's
// first half) and PostgreSQL's archiving and base backup (B-2, B-3), each against the stack's pinned image, on volumes
// of its own. Each file's cases share one container, in order.
export default defineConfig({ test: { include: ['src/vault-raft.int.ts', 'src/backup/pg-archive.int.ts'], testTimeout: 300_000, hookTimeout: 180_000, fileParallelism: false, sequence: { concurrent: false } } });
