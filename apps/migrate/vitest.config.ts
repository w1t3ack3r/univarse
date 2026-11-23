import { defineConfig } from 'vitest/config';

// Unit tests only; the integration suite (src/**/*.int.spec.ts, real databases) runs with vitest.int.config.ts.
export default defineConfig({ test: { include: ['src/**/*.spec.ts'], exclude: ['src/**/*.int.spec.ts'] } });
