import { defineConfig } from 'vitest/config';

// Spec 0020 B2-13, `pnpm --filter @univarse/stack test:restore` (CI): the restore's own steps on the stack's pinned
// images, in containers and volumes of their own: PostgreSQL to a time (BK4), Vault from a sealed snapshot with the
// first Vault's key (BK5), the files through the filer and back over S3 (B2-8), and the label-based teardown (BK6).
export default defineConfig({ test: { include: ['src/restore/restore.int.ts'], testTimeout: 300_000, hookTimeout: 300_000, fileParallelism: false, sequence: { concurrent: false } } });
