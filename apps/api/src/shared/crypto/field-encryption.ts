// Field-level encryption for secrets at rest (docs/07 §8, ADR-018).
// Format: v1:<keyId>:<iv b64url>:<ciphertext b64url>:<tag b64url>, AES-256-GCM, 96-bit random IV.
// AAD binds a ciphertext to its tenant + purpose, so a value copied to another row/tenant won't decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface FieldKeyring {
  /** Key used for new encryptions. */
  readonly currentKeyId: string;
  /** All keys still able to decrypt (rotation keeps old ids until re-encryption completes). */
  readonly keys: ReadonlyMap<string, Buffer>;
}

export function keyringFromEnv(keyId: string, base64Key: string): FieldKeyring {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64)');
  if (!/^[a-z0-9-]{1,32}$/.test(keyId)) throw new Error('DATA_ENCRYPTION_KEY_ID must be [a-z0-9-]{1,32}');
  return { currentKeyId: keyId, keys: new Map([[keyId, key]]) };
}

const b64u = (b: Buffer) => b.toString('base64url');

export function encryptField(ring: FieldKeyring, plaintext: Uint8Array, aad: string): string {
  const key = ring.keys.get(ring.currentKeyId);
  if (!key) throw new Error('Current encryption key missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v1', ring.currentKeyId, b64u(iv), b64u(ct), b64u(cipher.getAuthTag())].join(':');
}

export function decryptField(ring: FieldKeyring, stored: string, aad: string): Buffer {
  const parts = stored.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
  const [, keyId, iv, ct, tag] = parts as [string, string, string, string, string];
  const key = ring.keys.get(keyId);
  if (!key) throw new Error(`Unknown encryption key id ${keyId}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}
