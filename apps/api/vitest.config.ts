import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.spec.ts'],
    // Integration specs and the OB12 separate-process proof need services; they have their own configs.
    exclude: ['src/**/*.int.spec.ts', 'src/**/*.ob12.spec.ts'],
    passWithNoTests: true,
  },
});
