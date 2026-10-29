import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ArrowRight, Button, buttonClass } from '../index';
import { Phone } from './frames';

const meta = {
  title: 'Components/Button',
  component: Button,
  args: { children: 'Continue', onClick: fn() },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Action: Story = {};
export const Quiet: Story = { args: { variant: 'quiet', children: 'Back' } };
export const Plain: Story = { args: { variant: 'plain', children: 'Use a recovery code instead' } };
export const WithIcon: Story = {
  args: {
    children: (
      <>
        Continue <ArrowRight />
      </>
    ),
  },
};

/** Pending: busy, not pressable, and says so to assistive technology. */
export const Pending: Story = {
  args: { pending: true, children: 'Signing in' },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Signing in' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(button, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const Disabled: Story = { args: { disabled: true } };
export const LongLabel: Story = {
  args: { children: 'Send the activation code again to the email address we have on record for you' },
  decorators: [(S) => <Phone><S /></Phone>],
};
export const OneWord: Story = { args: { children: 'OK' } };
export const NonLatin: Story = { args: { children: 'Tẹ̀síwájú — Ọ̀ṣun' } };
export const BlockOnPhone: Story = { args: { block: true }, decorators: [(S) => <Phone><S /></Phone>] };

/** `buttonClass` styles a link as a button (Next's Link lives in the app). */
export const LinkStyledAsButton: Story = {
  render: () => (
    <a className={buttonClass('quiet')} href="#start">
      Start again
    </a>
  ),
};
