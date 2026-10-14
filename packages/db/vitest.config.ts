import { defineConfig } from 'vitest/config';

// Unit tests only; the integration suites (test/**/*.int.spec.ts) run with vitest.int.config.ts.
export default defineConfig({ test: { include: ['scripts/**/*.spec.ts'] } });
