import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Notice } from '../index';
import { Phone } from './frames';

const meta = {
  title: 'Components/Notice',
  component: Notice,
  args: { children: 'That code is not right. Check it and try again.' },
} satisfies Meta<typeof Notice>;
export default meta;
type Story = StoryObj<typeof meta>;

/** An error interrupts (role="alert") and carries the request id for support (docs/11 §2). */
export const Danger: Story = {
  args: { requestId: '01a184f9-0069-7a2c-8654-33d683776fd9' },
  play: async ({ canvasElement }) => {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Support reference: 01a184f9-0069-7a2c-8654-33d683776fd9');
  },
};

/** Information and success are polite (role="status"), never an alert. */
export const Info: Story = {
  args: { tone: 'info', children: 'If an account exists, we have sent a code.' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toBeInTheDocument();
    await expect(within(canvasElement).queryByRole('alert')).toBeNull();
  },
};
export const Success: Story = { args: { tone: 'success', children: 'Your password has been changed.' } };
export const NoRequestId: Story = {};
export const LongOnPhone: Story = {
  args: {
    requestId: '01a184f9-0069-7a2c-8654-33d683776fd9',
    children:
      'We could not reach the server. Your answers are saved on this device and will be sent when the connection comes back.',
  },
  decorators: [(S) => <Phone><S /></Phone>],
};
