import { describe, expect, it } from 'vitest';
import { backoffMs, errorSummary, MAX_ATTEMPTS } from './delivery-policy.js';

describe('[B4] retry policy', () => {
  it('doubles from 30 s and caps at 1 h (no jitter at the midpoint)', () => {
    const mid = () => 0.5;
    expect(backoffMs(1, mid)).toBe(30_000);
    expect(backoffMs(2, mid)).toBe(60_000);
    expect(backoffMs(5, mid)).toBe(480_000);
    expect(backoffMs(8, mid)).toBe(3_600_000);
    expect(backoffMs(30, mid)).toBe(3_600_000);
  });

  it('jitters within ±20 %', () => {
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
  });

  it('gives up after 8 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });
});

describe('[B4] last_error holds no PII', () => {
  it('keeps the error class and SMTP codes, never the message', () => {
    const err = Object.assign(new Error('550 5.1.1 <ada@student.example> mailbox unavailable'), { code: 'EENVELOPE', responseCode: 550 });
    const summary = errorSummary(err);
    expect(summary).toBe('Error:EENVELOPE:550');
    expect(summary).not.toMatch(/@|ada|mailbox/);
  });

  it('drops code fields that do not look like codes', () => {
    const err = Object.assign(new Error('x'), { name: 'Smtp <bob@evil.example>', code: 'bob@evil.example', responseCode: '550 bob' });
    expect(errorSummary(err)).toBe('Error');
    expect(errorSummary('not an error')).toBe('UnknownError');
  });
});
