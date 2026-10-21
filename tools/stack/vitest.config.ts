import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.spec.ts'], testTimeout: 180_000 } });
