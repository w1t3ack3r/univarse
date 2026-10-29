// Spec 0026 SB1: Storybook for the shared components, plain React on Vite (no Next.js adapter: the package uses none).
// SB7: nothing leaves the machine; telemetry is off and the static build is a CI check, never published or deployed.
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
};

export default config;
