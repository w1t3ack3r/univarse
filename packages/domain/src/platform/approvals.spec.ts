import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_KIND_NAMES,
  APPROVAL_KINDS,
  approvalExpiry,
  approvalSubject,
  canonicalJson,
  decisionRefusal,
  effectiveApprovalStatus,
  possibleApprovers,
  secondPersonAvailable,
  type StaffForApproval,
} from './approvals.js';
import { PLATFORM_PERMISSIONS } from './permissions.js';

const NOW = new Date('2026-11-13T12:00:00Z');
const REQUESTER = '00000000-0000-7000-8000-000000000001';
const SUBJECT = '00000000-0000-7000-8000-000000000002';
const APPROVER = '00000000-0000-7000-8000-000000000003';
const HASH = 'a'.repeat(64);

const pending = (over: Partial<Parameters<typeof decisionRefusal>[0]> = {}) => ({
  kind: 'staff.make_owner' as const,
  status: 'PENDING' as const,
  expiresAt: new Date(NOW.getTime() + 60_000),
  requestedBy: REQUESTER,
  subjectId: SUBJECT,
  payloadHash: HASH,
  ...over,
});

describe('canonicalJson (spec 0037 Q3)', () => {
  it('sorts keys at every depth, so the same content always hashes the same', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: true, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[2,{"y":null,"z":true}]},"b":1}');
  });

  it('any key order gives the same text', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null))), (o) => {
        const reversed = Object.fromEntries(Object.entries(o).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(o));
        expect(JSON.parse(canonicalJson(o))).toEqual(o);
      }),
    );
  });

  it('refuses what JSON cannot hold', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });
});

describe('the decision rules (spec 0037 Q3, T24)', () => {
  const owner = { userId: APPROVER, role: 'SUPER_ADMIN' };

  it('a different member holding the approve permission may decide a live request with the shown hash', () => {
    expect(decisionRefusal(pending(), owner, HASH, NOW)).toBeNull();
    expect(decisionRefusal(pending(), owner, null, NOW)).toBeNull();
  });

  it('the requester never approves their own request', () => {
    expect(decisionRefusal(pending(), { userId: REQUESTER, role: 'OWNER' }, HASH, NOW)).toBe('own_request');
  });

  it('nobody approves a request that names them', () => {
    expect(decisionRefusal(pending(), { userId: SUBJECT, role: 'OWNER' }, HASH, NOW)).toBe('names_you');
  });

  it('a role without the approve permission is refused, before anything else is said', () => {
    for (const role of ['SUPPORT', 'FINANCE', 'READ_ONLY', 'NOBODY']) expect(decisionRefusal(pending(), { userId: REQUESTER, role }, HASH, NOW)).toBe('not_allowed');
  });

  it('only once: anything but PENDING is refused', () => {
    for (const status of ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'EXECUTED', 'FAILED'] as const) expect(decisionRefusal(pending({ status }), owner, HASH, NOW)).toBe('not_pending');
  });

  it('not at or after the expiry', () => {
    expect(decisionRefusal(pending({ expiresAt: NOW }), owner, HASH, NOW)).toBe('expired');
    expect(decisionRefusal(pending({ expiresAt: new Date(NOW.getTime() + 1) }), owner, HASH, NOW)).toBeNull();
  });

  it('another payload hash is refused', () => {
    expect(decisionRefusal(pending(), owner, 'b'.repeat(64), NOW)).toBe('payload_changed');
  });

  it('a stored PENDING past its expiry reads as EXPIRED; nothing else changes', () => {
    expect(effectiveApprovalStatus({ status: 'PENDING', expiresAt: NOW }, NOW)).toBe('EXPIRED');
    expect(effectiveApprovalStatus({ status: 'PENDING', expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe('PENDING');
    expect(effectiveApprovalStatus({ status: 'EXECUTED', expiresAt: new Date(0) }, NOW)).toBe('EXECUTED');
  });
});

describe('no solo bypass (spec 0037 Q5, A7)', () => {
  const m = (id: string, role: string, over: Partial<StaffForApproval> = {}): StaffForApproval => ({ id, role, isActive: true, mfaEnrolled: true, ...over });

  it('a lone owner has nobody to approve', () => {
    expect(secondPersonAvailable('staff.make_owner', [m(REQUESTER, 'OWNER')], REQUESTER, SUBJECT)).toBe(false);
  });

  it('the person named, an inactive member, one without an authenticator, or one without the permission does not count', () => {
    const staff = [m(REQUESTER, 'OWNER'), m(SUBJECT, 'SUPER_ADMIN'), m('x1', 'OWNER', { isActive: false }), m('x2', 'SUPER_ADMIN', { mfaEnrolled: false }), m('x3', 'SUPPORT'), m('x4', 'READ_ONLY')];
    expect(secondPersonAvailable('staff.make_owner', staff, REQUESTER, SUBJECT)).toBe(false);
    expect(possibleApprovers('staff.make_owner', staff, REQUESTER, SUBJECT)).toEqual([]);
  });

  it('a second OWNER or SUPER_ADMIN is enough', () => {
    expect(secondPersonAvailable('staff.make_owner', [m(REQUESTER, 'OWNER'), m(APPROVER, 'SUPER_ADMIN')], REQUESTER, SUBJECT)).toBe(true);
    expect(possibleApprovers('staff.make_owner', [m(REQUESTER, 'OWNER'), m(APPROVER, 'OWNER')], REQUESTER, SUBJECT).map((s) => s.id)).toEqual([APPROVER]);
  });
});

describe('the kinds (spec 0037 Q2, Q4)', () => {
  it('S6 declares one kind, staff.make_owner, approved by a decider within 24 hours', () => {
    expect(APPROVAL_KIND_NAMES).toEqual(['staff.make_owner']);
    expect(APPROVAL_KINDS['staff.make_owner']).toEqual({ requestPermission: 'platform.staff.manage', approvePermission: 'platform.approval.decide', ttlMs: 24 * 3_600_000, subjectField: 'memberId' });
    expect(approvalExpiry('staff.make_owner', NOW).toISOString()).toBe('2026-11-14T12:00:00.000Z');
  });

  it("every kind's permissions are catalogued", () => {
    for (const k of APPROVAL_KIND_NAMES) {
      expect(PLATFORM_PERMISSIONS).toContain(APPROVAL_KINDS[k].requestPermission);
      expect(PLATFORM_PERMISSIONS).toContain(APPROVAL_KINDS[k].approvePermission);
    }
  });

  it('the subject is read from the kind’s field only', () => {
    expect(approvalSubject('staff.make_owner', { memberId: SUBJECT })).toBe(SUBJECT);
    expect(approvalSubject('staff.make_owner', { member: SUBJECT })).toBeNull();
  });
});
