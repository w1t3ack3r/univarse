import { describe, expect, it } from 'vitest';
import { blankAt, CONTACT_UNDO_WINDOW_MS, mayMarkOldAddressWrong, maskAddress, needsPassword, undoDeadline, withinRequestLimit } from './contact-change.js';

describe('who proves what (spec 0032 Q2, Q7, Q8)', () => {
  it('asks for the password whenever someone else started the change', () => {
    expect(needsPassword('SELF')).toBe(false);
    expect(needsPassword('ADMIN')).toBe(true);
    expect(needsPassword('COMMAND')).toBe(true);
  });

  it('never lets a member silence their own old address', () => {
    expect(mayMarkOldAddressWrong('SELF')).toBe(false);
    expect(mayMarkOldAddressWrong('ADMIN')).toBe(true);
    expect(mayMarkOldAddressWrong('COMMAND')).toBe(true);
  });
});

describe('the limits (Q3, Q6, Q12)', () => {
  it('allows three requests an hour', () => {
    expect(withinRequestLimit(2)).toBe(true);
    expect(withinRequestLimit(3)).toBe(false);
  });

  it('closes an undo after 72 hours', () => {
    expect(undoDeadline(new Date(0)).getTime()).toBe(72 * 3_600_000);
  });

  it('keeps a confirmed change’s addresses for its undo window, and an unconfirmed one’s for the limit’s hour', () => {
    const at = new Date('2026-11-07T10:00:00Z');
    expect(blankAt({ confirmedAt: at, expiresAt: at }).getTime()).toBe(at.getTime() + CONTACT_UNDO_WINDOW_MS);
    expect(blankAt({ confirmedAt: null, expiresAt: at }).getTime()).toBe(at.getTime() + 3_600_000);
  });
});

describe('maskAddress (Q6)', () => {
  it('leaves a first letter each side and the last part of the domain', () => {
    expect(maskAddress('samuel@gmail.com')).toBe('s•••@g•••.com');
    expect(maskAddress('a@mail.uni.edu.ng')).toBe('a•••@m•••.ng');
  });

  it('shows nothing of something that isn’t an address', () => {
    expect(maskAddress('nothing')).toBe('•••');
    expect(maskAddress('@x.ng')).toBe('•••');
  });
});
