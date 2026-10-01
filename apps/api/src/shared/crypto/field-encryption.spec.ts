import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, keyringFromEnv, type FieldKeyring } from './field-encryption.js';

const ring = keyringFromEnv('k1', randomBytes(32).toString('base64'));
const secret = Buffer.from('totp-secret-20-bytes');

describe('field encryption (AES-256-GCM, versioned, AAD-bound)', () => {
  it('round-trips and never contains the plaintext', () => {
    const stored = encryptField(ring, secret, 'tenant-a:totp');
    expect(stored).toMatch(/^v1:k1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(stored).not.toContain(secret.toString('base64url'));
    expect(decryptField(ring, stored, 'tenant-a:totp').equals(secret)).toBe(true);
  });

  it('uses a fresh IV every time', () => {
    expect(encryptField(ring, secret, 'x')).not.toBe(encryptField(ring, secret, 'x'));
  });

  it('refuses to decrypt under a different AAD (copied to another tenant/purpose)', () => {
    const stored = encryptField(ring, secret, 'tenant-a:totp');
    expect(() => decryptField(ring, stored, 'tenant-b:totp')).toThrow();
  });

  it('detects tampering', () => {
    const parts = encryptField(ring, secret, 'a').split(':');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 1;
    parts[3] = ct.toString('base64url');
    expect(() => decryptField(ring, parts.join(':'), 'a')).toThrow();
  });

  it('decrypts with an old key after rotation', () => {
    const old = encryptField(ring, secret, 'a');
    const rotated: FieldKeyring = { currentKeyId: 'k2', keys: new Map([...ring.keys, ['k2', randomBytes(32)]]) };
    expect(encryptField(rotated, secret, 'a').startsWith('v1:k2:')).toBe(true);
    expect(decryptField(rotated, old, 'a').equals(secret)).toBe(true);
  });

  it('validates key material', () => {
    expect(() => keyringFromEnv('k1', randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => keyringFromEnv('Bad Id!', randomBytes(32).toString('base64'))).toThrow();
  });
});
