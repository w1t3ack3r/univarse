import { describe, expect, it } from 'vitest';
import { APPROVAL_CONSEQUENCE, APPROVAL_FAILURE, APPROVAL_KIND_LABEL, APPROVAL_STATUS, approvalAction, timeLeft } from './approvals';

describe('the approval words (spec 0037)', () => {
  it('says the action with the person it names, or that they are gone', () => {
    expect(approvalAction({ kind: 'staff.make_owner', subject: { id: 'x', name: 'Ada Obi' } })).toBe('Make Ada Obi an owner');
    expect(approvalAction({ kind: 'staff.make_owner', subject: { id: 'x', name: null } })).toBe('Make a former member an owner');
  });

  it('every kind, status and failure has its words', () => {
    expect(Object.keys(APPROVAL_KIND_LABEL)).toEqual(Object.keys(APPROVAL_CONSEQUENCE));
    expect(Object.keys(APPROVAL_STATUS).sort()).toEqual(['APPROVED', 'CANCELLED', 'EXECUTED', 'EXPIRED', 'FAILED', 'PENDING', 'REJECTED']);
    expect(Object.keys(APPROVAL_FAILURE).sort()).toEqual(['already_done', 'state_conflict', 'subject_gone', 'subject_inactive']);
  });

  it('the time left never reads later than it is', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(timeLeft('2026-11-13T12:00:30Z', now)).toBe('in under a minute');
    expect(timeLeft('2026-11-13T12:40:59Z', now)).toBe('in 40 min');
    expect(timeLeft('2026-11-13T17:59:00Z', now)).toBe('in 5 h');
    expect(timeLeft('2026-11-14T12:00:00Z', now)).toBe('in 24 h');
  });
});
