import { describe, expect, it } from 'vitest';
import { size } from './backup.js';

describe('size', () => {
  it('tells a small artifact from an empty one', () => {
    expect(size(0)).toBe('0 B');
    expect(size(1023)).toBe('1023 B');
    expect(size(1024)).toBe('1.0 KB');
    expect(size(6 * 1024 + 512)).toBe('6.5 KB');
    expect(size(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(size(1024 * 1024)).toBe('1.0 MB');
    expect(size(58.3 * 1024 * 1024)).toBe('58.3 MB');
  });
});
