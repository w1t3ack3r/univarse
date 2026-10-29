import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptHidden } from './hidden-prompt.js';

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (c: Buffer) => (shown += c.toString()));
  return { input, output, shown: () => shown };
}

// Typed one keystroke at a time, as a terminal sends them: readline redraws the line after each one.
function type(input: PassThrough, keys: string) {
  for (const k of keys) input.write(k);
}

describe('promptHidden', () => {
  it('returns what was typed and shows only the question', async () => {
    const h = harness();
    const answer = promptHidden('Password: ', h.input, h.output);
    type(h.input, 'Zq7-unusual-secret\r');
    await expect(answer).resolves.toBe('Zq7-unusual-secret');
    expect(h.shown()).toBe('Password: \n');
  });

  it('applies backspace without echoing either version of the line', async () => {
    const h = harness();
    const answer = promptHidden('Password: ', h.input, h.output);
    type(h.input, 'abcX\x7fd\r');
    await expect(answer).resolves.toBe('abcd');
    expect(h.shown()).toBe('Password: \n');
  });

  it('rejects on Ctrl+C instead of hanging', async () => {
    const h = harness();
    const answer = promptHidden('Password: ', h.input, h.output);
    type(h.input, 'abc\x03');
    await expect(answer).rejects.toThrow(/abort/i);
    expect(h.shown()).not.toContain('abc');
  });
});
