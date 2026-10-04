import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { redact, REDACTED } from './redact.js';

describe('[A9] canonical JSON', () => {
  it('is independent of key order, recursively', () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } };
    const b = { a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('normalises dates, bigints and bytes; drops undefined; keeps array order', () => {
    expect(canonicalJson({ t: new Date('2026-10-04T10:00:00.000+01:00'), n: 7n, u: undefined, b: new Uint8Array([1, 2]) })).toBe(
      '{"b":"AQI=","n":"7","t":"2026-10-04T09:00:00.000Z"}',
    );
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('rejects non-finite numbers (they would hash ambiguously)', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });
});

describe('[A6] redaction', () => {
  it('replaces secret-looking keys recursively, keeps the rest', () => {
    const out = redact({
      username: 'ADMIN001',
      password: 'p',
      newPassword: 'p2',
      code: '123456',
      passwordHash: '$argon2id$…',
      nested: { recoveryCodes: ['A', 'B'], sessionToken: 't', status: 'ACTIVE' },
      list: [{ otp: '1' }, { label: 'ok' }],
    });
    expect(out).toEqual({
      username: 'ADMIN001',
      password: REDACTED,
      newPassword: REDACTED,
      code: REDACTED,
      passwordHash: REDACTED,
      nested: { recoveryCodes: REDACTED, sessionToken: REDACTED, status: 'ACTIVE' },
      list: [{ otp: REDACTED }, { label: 'ok' }],
    });
  });

  it('leaves primitives and dates untouched', () => {
    const d = new Date();
    expect(redact('x')).toBe('x');
    expect(redact(d)).toBe(d);
    expect(redact(null)).toBeNull();
  });
});
