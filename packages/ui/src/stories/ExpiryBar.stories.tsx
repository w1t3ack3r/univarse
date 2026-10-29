import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';
import { ExpiryBar } from '../client';
import { Phone } from './frames';

const meta = {
  title: 'Components/ExpiryBar',
  component: ExpiryBar,
  args: { minutes: 10, onExpire: fn() },
} satisfies Meta<typeof ExpiryBar>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A fresh code: the words say how long is left, and nothing has expired. */
export const Fresh: Story = {
  args: { issuedAt: Date.now() },
  play: async ({ canvasElement, args }) => {
    await expect(within(canvasElement).getByText('Valid for 10 more minutes')).toBeInTheDocument();
    await expect(args.onExpire).not.toHaveBeenCalled();
  },
};
export const AboutAMinuteLeft: Story = { args: { issuedAt: Date.now() - 9 * 60_000 - 30_000 } };

/** An expired code says so, and `onExpire` fires exactly once. */
export const Expired: Story = {
  args: { issuedAt: Date.now() - 11 * 60_000 },
  play: async ({ canvasElement, args }) => {
    await expect(within(canvasElement).getByText('This code has expired. Ask for a new one.')).toBeInTheDocument();
    await waitFor(() => expect(args.onExpire).toHaveBeenCalledTimes(1));
  },
};
export const OnPhone: Story = { args: { issuedAt: Date.now() }, decorators: [(S) => <Phone><S /></Phone>] };
