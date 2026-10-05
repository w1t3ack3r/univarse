// Field cipher formats (spec 0006 E4, docs/07 §8). AES-256-GCM, random 96-bit IV, AAD always bound.
//   v2:<keyVersion>:<iv>:<ciphertext>:<tag>   per-tenant DEK; the tenant is implied by context and AAD
//   v1:<keyId>:<iv>:<ciphertext>:<tag>        legacy single platform key (ADR-018); read-only until E9
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const b64u = (b: Buffer) => b.toString('base64url');

function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): [string, string, string] {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [b64u(iv), b64u(ct), b64u(cipher.getAuthTag())];
}

function open(key: Uint8Array, iv: string, ct: string, tag: string, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

export interface ParsedCipher {
  readonly format: 'v1' | 'v2';
  /** v2: the tenant DEK version. v1: the legacy key id. */
  readonly key: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

export function parseCipher(stored: string): ParsedCipher {
  const parts = stored.split(':');
  if (parts.length !== 5 || (parts[0] !== 'v1' && parts[0] !== 'v2')) throw new Error('Unsupported ciphertext format');
  const [format, key, iv, ct, tag] = parts as ['v1' | 'v2', string, string, string, string];
  if (format === 'v2' && !/^[1-9]\d{0,8}$/.test(key)) throw new Error('Unsupported ciphertext format');
  return { format, key, iv, ct, tag };
}

/** The key a stored value needs: `'v1'` (legacy) or its v2 DEK version. Used by the sweep (E7, E9). */
export function keyVersionOf(stored: string): 'v1' | number {
  const parsed = parseCipher(stored);
  return parsed.format === 'v1' ? 'v1' : Number(parsed.key);
}

export function encryptV2(dek: Uint8Array, version: number, plaintext: Uint8Array, aad: string): string {
  if (dek.length !== 32) throw new Error('DEK must be 32 bytes');
  return ['v2', String(version), ...seal(dek, plaintext, aad)].join(':');
}

export function decryptWith(key: Uint8Array, parsed: ParsedCipher, aad: string): Buffer {
  return open(key, parsed.iv, parsed.ct, parsed.tag, aad);
}

/** Legacy v1 keyring (ADR-018): decrypt-only during migration (spec 0006 E9). */
export interface LegacyKeyring {
  readonly keys: ReadonlyMap<string, Buffer>;
}

export function legacyKeyringFromEnv(keyId: string | undefined, base64Key: string | undefined): LegacyKeyring {
  if (!keyId || !base64Key) return { keys: new Map() };
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (base64)');
  return { keys: new Map([[keyId, key]]) };
}

/** Test/fixture helper only: writes the legacy format, so migration paths can be exercised. */
export function encryptV1ForTests(ring: LegacyKeyring, keyId: string, plaintext: Uint8Array, aad: string): string {
  const key = ring.keys.get(keyId);
  if (!key) throw new Error('Unknown legacy key id');
  return ['v1', keyId, ...seal(key, plaintext, aad)].join(':');
}
