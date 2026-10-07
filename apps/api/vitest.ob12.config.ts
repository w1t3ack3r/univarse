import { defineConfig } from 'vitest/config';
import int from './vitest.int.config.js';

// Spec 0012 OB12: the separate-process proof, alone. Needs the built API (`pnpm build`) and the collector
// (`pnpm dev:traces`); CI runs it as its own step after the integration tests. `include` is REPLACED, not
// merged (mergeConfig would append it to the integration suite's).
export default defineConfig({ ...int, test: { ...int.test, include: ['src/**/*.ob12.spec.ts'] } });
