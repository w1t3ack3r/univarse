import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Steps } from '../index';
import { Phone } from './frames';

const meta = {
  title: 'Components/Steps',
  component: Steps,
  args: { steps: ['Account', 'Verify', 'Password'], current: 0 },
} satisfies Meta<typeof Steps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const First: Story = {};

/** The current step is marked for assistive technology, and the list says where you are. */
export const Middle: Story = {
  args: { current: 1 },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('list', { name: 'Step 2 of 3' });
    const current = within(list).getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'step');
    await expect(current).toHaveLength(1);
    await expect(current[0]).toHaveTextContent('Verify');
  },
};
export const Last: Story = { args: { current: 2 } };
export const ManyOnPhone: Story = {
  args: { steps: ['Account', 'Verify email', 'Set password', 'Authenticator app', 'Recovery codes'], current: 3 },
  decorators: [(S) => <Phone><S /></Phone>],
};
