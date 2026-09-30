import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** 256-bit opaque session token (docs/08 §3.3). Only its SHA-256 is stored. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

/** Prisma 7 maps Bytes to Uint8Array<ArrayBuffer>; copy out of Node's pooled Buffer memory. */
const bytes = (b: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export const sha256 = (value: string): Uint8Array<ArrayBuffer> => bytes(createHash('sha256').update(value).digest());

/** 6-digit one-time code. Low entropy ⇒ hashed with a server-side pepper and attempt-limited. */
export const newOneTimeCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');

export const hashOneTimeCode = (pepper: string, userId: string, purpose: string, code: string): Uint8Array<ArrayBuffer> =>
  bytes(createHmac('sha256', pepper).update(`${userId}:${purpose}:${code}`).digest());

export const safeEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && timingSafeEqual(a, b);

/** Login identifiers: usernames upper-cased, emails lower-cased, Unicode-normalised. */
export function normaliseIdentifier(raw: string): { kind: 'email' | 'username'; value: string } {
  const v = raw.normalize('NFKC').trim();
  return v.includes('@') ? { kind: 'email', value: v.toLowerCase() } : { kind: 'username', value: v.toUpperCase() };
}
