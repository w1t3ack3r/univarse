import { defineConfig } from 'vitest/config';

// Spec 0020 A2-13: the destruction protocol against the real keys CLI and database, on CI's disposable database only
// (`pnpm --filter @univarse/stack test:ledger`, after the API's integration tests). Its cases share one ledger, in order.
export default defineConfig({ test: { include: ['src/ledger/real-keys.int.ts'], testTimeout: 600_000, fileParallelism: false, sequence: { concurrent: false } } });
