import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, within } from 'storybook/test';
import { CopyButton } from '../client';

const meta = { title: 'Components/CopyButton', component: CopyButton, args: { text: 'ABCD-EFGH-JKLM' } } satisfies Meta<typeof CopyButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const CustomLabel: Story = { args: { label: 'Copy all codes' } };

/** It copies exactly its text, then says "Copied" in a polite live region. */
export const Copies: Story = {
  play: async ({ canvasElement, args }) => {
    const write = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Copy' }));
    await expect(write).toHaveBeenCalledWith(args.text);
    await expect(await canvas.findByText('Copied')).toHaveAttribute('aria-live', 'polite');
    write.mockRestore();
  },
};
