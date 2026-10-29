import type { ComponentType } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import * as iconModule from '../icons';

type IconComponent = ComponentType<{ size?: number; label?: string }>;
// Every icon the module exports, read from the module itself: a new icon can't be left out of the gallery.
const icons = Object.entries(iconModule as unknown as Record<string, IconComponent>).sort(([a], [b]) => a.localeCompare(b));

function Gallery() {
  return (
    <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 16, listStyle: 'none', padding: 0, margin: 0 }}>
      {icons.map(([name, Icon]) => (
        <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon size={24} />
          <span style={{ fontSize: 'var(--uv-text-sm)' }}>{name}</span>
        </li>
      ))}
    </ul>
  );
}

const meta = { title: 'Foundations/Icons', component: Gallery } satisfies Meta<typeof Gallery>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Decorative by default: every icon is hidden from assistive technology unless it's given a label. */
export const All: Story = {
  play: async ({ canvasElement }) => {
    const svgs = canvasElement.querySelectorAll('svg');
    await expect(svgs.length).toBeGreaterThanOrEqual(25);
    await expect(svgs).toHaveLength(icons.length);
    for (const svg of svgs) await expect(svg).toHaveAttribute('aria-hidden', 'true');
  },
};

/** With a label, an icon is announced as an image by that name. */
export const Labelled: Story = {
  render: () => <iconModule.ShieldCheck size={32} label="Two-step verification is on" />,
  play: async ({ canvasElement }) => {
    const svg = canvasElement.querySelector('svg');
    await expect(svg).toHaveAttribute('role', 'img');
    await expect(svg).toHaveAccessibleName('Two-step verification is on');
  },
};
