// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) and RFC 4648 base32 — no runtime dependency.
// Spec 0001 Part M design decisions.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret (RFC 4226 recommends ≥128, SHA-1 block-friendly 160). */
export const newTotpSecret = (): Buffer => randomBytes(20);

export const timeStep = (unixMs: number): number => Math.floor(unixMs / 1000 / TOTP_STEP_SEC);

/** HOTP value for a counter (RFC 4226 §5.3 dynamic truncation). */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Returns the matching time step within ±window of `nowMs`, or null.
 * The caller enforces replay protection by rejecting steps ≤ the last accepted step (M5).
 * Compares every candidate (no early exit) to keep timing independent of which step matched.
 */
export function verifyTotp(secret: Uint8Array, code: string, nowMs: number, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = timeStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, s)), given) && matched === null) matched = s;
  }
  return matched;
}

/** otpauth:// URI for authenticator apps (Key Uri Format). */
export function otpauthUri(secret: Uint8Array, issuer: string, account: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
