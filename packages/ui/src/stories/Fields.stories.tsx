import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PasswordField, TextField } from '../client';
import { Phone } from './frames';

const meta = { title: 'Components/Fields', component: TextField, args: { label: 'Email address', name: 'email' } } satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Text: Story = {};
export const WithHint: Story = { args: { hint: 'The one your institution gave you.' } };

/** An error is linked to the input and marks it invalid (W9). */
export const WithError: Story = {
  args: { hint: 'The one your institution gave you.', error: 'Enter an email address like name@school.edu.ng' },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByLabelText('Email address');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(/The one your institution gave you\..*Enter an email address/);
  },
};
export const Disabled: Story = { args: { disabled: true, defaultValue: 'adebayo@demo-uni.edu.ng' } };
export const NonLatinOnPhone: Story = {
  args: { label: 'Orúkọ àti orúkọ ìdílé', defaultValue: 'Ọ̀ṣun Adébáyọ̀-Chukwuemeka' },
  decorators: [(S) => <Phone><S /></Phone>],
};

/** Show and hide: the input's type and the toggle's name and pressed state change together. */
export const Password: Story = {
  render: () => <PasswordField label="Password" name="password" defaultValue="correct horse battery" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Password');
    await expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(canvas.getByRole('button', { name: 'Show password' }));
    await expect(input).toHaveAttribute('type', 'text');
    const hide = canvas.getByRole('button', { name: 'Hide password' });
    await expect(hide).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(hide);
    await expect(input).toHaveAttribute('type', 'password');
    await expect(canvas.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false');
  },
};
export const PasswordWithErrorOnPhone: Story = {
  render: () => <PasswordField label="New password" name="password" hint="At least 12 characters." error="That password appears in known data breaches. Choose another." />,
  decorators: [(S) => <Phone><S /></Phone>],
};
