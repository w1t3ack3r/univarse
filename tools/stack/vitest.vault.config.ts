import { defineConfig } from 'vitest/config';

// Spec 0023, `pnpm --filter @univarse/stack test:vault` (CI): the Vault tokens' lifecycle on a throwaway Vault of the
// stack's pinned image: periods, renewal, the policies' self paths, a dead token re-issued, a sealed Vault named, and
// the app's renewer keeping a short-period token alive. One container, its cases in order.
export default defineConfig({ test: { include: ['src/vault-token.int.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false, sequence: { concurrent: false } } });
