// Spec 0026 SB6: two deliberate accessibility violations. scripts/a11y-proof.mjs requires that each of these stories
// fails, for exactly its rule. Never part of the real story set (.storybook/main.ts reads src/ only).
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Copy } from '../src/icons';

function Broken() {
  return null;
}

const meta = { title: 'Proof/Accessibility', component: Broken } satisfies Meta<typeof Broken>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The brand rule broken: lime as text on the off-white ground (about 1.3:1). Must fail `color-contrast`. */
export const LimeTextOnOffWhite: Story = {
  render: () => (
    <p style={{ color: 'var(--uv-lime)', background: 'var(--uv-offwhite)', fontSize: 16, margin: 0, padding: 8 }}>
      Continue to your dashboard
    </p>
  ),
};

/** An icon-only button with no name. Must fail `button-name`. */
export const IconButtonWithoutName: Story = {
  render: () => (
    <button type="button" className="uv-btn uv-btn--quiet">
      <Copy />
    </button>
  ),
};
