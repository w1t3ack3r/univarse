import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, timeStep, verifyTotp } from './totp.js';

// RFC 6238 Appendix B (SHA1 seed) — 8-digit values; our 6-digit codes are their last 6 digits.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('HOTP/TOTP (RFC 4226 / RFC 6238)', () => {
  it.each(RFC_VECTORS)('matches RFC 6238 vector at T=%i', (t, expected8) => {
    expect(hotp(RFC_SEED, timeStep(t * 1000), 8)).toBe(expected8);
    expect(hotp(RFC_SEED, timeStep(t * 1000))).toBe(expected8.slice(-6));
  });

  it('matches RFC 4226 Appendix D HOTP values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, c) => hotp(RFC_SEED, c))).toEqual(expected);
  });

  it('accepts ±1 step and returns the matched step; rejects ±2', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_SEED, hotp(RFC_SEED, step + d), now)).toBe(step + d);
    for (const d of [-2, 2]) expect(verifyTotp(RFC_SEED, hotp(RFC_SEED, step + d), now)).toBeNull();
  });

  it('rejects malformed codes', () => {
    for (const c of ['', '12345', '1234567', 'abcdef', ' 12345']) expect(verifyTotp(RFC_SEED, c, Date.now())).toBeNull();
  });
});

describe('base32 (RFC 4648)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %s and round-trips', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('otpauth URI', () => {
  it('encodes issuer, account and parameters', () => {
    const uri = otpauthUri(RFC_SEED, 'DEMO-UNI UniVarse', 'ADMIN001');
    expect(uri.startsWith('otpauth://totp/DEMO-UNI%20UniVarse%3AADMIN001?')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe(base32Encode(RFC_SEED));
    expect([params.get('digits'), params.get('period'), params.get('algorithm')]).toEqual(['6', '30', 'SHA1']);
  });
});
