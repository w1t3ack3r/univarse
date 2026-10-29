// The components drawn exactly as the web app draws them: Poppins self-hosted, then the tokens and the components' CSS
// (apps/web/src/app/globals.css, spec 0005 W3).
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '../src/tokens.css';
import '../src/components.css';
import type { Preview } from '@storybook/react-vite';

const preview: Preview = {
  parameters: {
    // SB3: an axe violation in any story fails its test, in CI and locally.
    a11y: { test: 'error' },
    layout: 'padded',
    backgrounds: { disable: true },
  },
  decorators: [
    (Story) => (
      <div style={{ background: 'var(--uv-bg)', color: 'var(--uv-text)', fontFamily: 'var(--uv-font)', padding: 24 }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;
