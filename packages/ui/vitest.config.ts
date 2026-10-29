// Spec 0026 SB3: every story runs as a test in a real browser (Chromium, the E2E suite's Playwright build), with axe.
// Two projects: `stories` (the real set; must pass) and `a11y-proof` (SB6; must fail, checked by scripts/a11y-proof.mjs).
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const browser = { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' as const }] };

export default defineConfig({
  test: {
    projects: [
      { extends: true, plugins: [storybookTest({ configDir: dir('.storybook') })], test: { name: 'stories', browser } },
      { extends: true, plugins: [storybookTest({ configDir: dir('.storybook-proof') })], test: { name: 'a11y-proof', browser } },
    ],
  },
});
