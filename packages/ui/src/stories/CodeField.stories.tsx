import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CodeField } from '../client';
import { Phone } from './frames';

/** CodeField is controlled; the stories hold its value as a sign-in screen does. */
function Controlled({ initial = '', error, length }: { initial?: string; error?: string; length?: number }) {
  const [value, setValue] = useState(initial);
  return <CodeField label="Verification code" hint="Sent to your email address." value={value} onChange={setValue} {...(error ? { error } : {})} {...(length ? { length } : {})} />;
}

const meta = { title: 'Components/CodeField', component: Controlled } satisfies Meta<typeof Controlled>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const PartlyFilled: Story = { args: { initial: '482' } };
export const Invalid: Story = { args: { initial: '482913', error: 'That code is not right. Check it and try again.' } };
export const EightDigitsOnPhone: Story = { args: { length: 8 }, decorators: [(S) => <Phone><S /></Phone>] };

/** Typing drops anything that isn't a digit; the cells show what the one real input holds. */
export const TypingDropsNonDigits: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByLabelText('Verification code');
    await userEvent.type(input, '4a8-2 9');
    await expect(input).toHaveValue('4829');
    const cells = canvasElement.querySelectorAll('.uv-code__cell');
    await expect([...cells].map((c) => c.textContent).join('')).toBe('4829');
  },
};

/** A code pasted as an email shows it, "123 456", fills all six cells (found by this story: maxLength cut it to five). */
export const PasteWithASpace: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByLabelText('Verification code');
    await userEvent.click(input);
    await userEvent.paste('123 456');
    await expect(input).toHaveValue('123456');
  },
};

/** A pasted code fills the field, cut to its length, and backspace takes digits off the end. */
export const PasteAndBackspace: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByLabelText('Verification code');
    await userEvent.click(input);
    await userEvent.paste('Your code: 123 456 789');
    await expect(input).toHaveValue('123456');
    await userEvent.type(input, '{Backspace}{Backspace}');
    await expect(input).toHaveValue('1234');
  },
};
