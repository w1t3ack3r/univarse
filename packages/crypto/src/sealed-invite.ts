// Spec 0034 Q7: the first IT Admin's details, sealed by the console for the worker only. A fresh 256-bit key encrypts
// the details (AES-256-GCM); the provisioning Transit key wraps that key. On the stack the console's token may only
// encrypt with it and the worker's only decrypt, so neither process can do the other's half. Both halves are bound to
// the institution: a sealed invite copied onto another job won't open.
//   inv1:<wrapped key>|<iv>|<ciphertext>|<tag>
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TAG_BYTES } from './cipher.js';
import { KeyUnavailableError, type KeyProvider } from './providers.js';

export interface InviteDetails {
  readonly displayName: string;
  readonly email: string;
  readonly username: string;
}

/** The Transit key the invites are sealed with (spec 0034 Q7): its own, never the tenant KEK or the console's. */
export const PROVISIONING_KEK = 'univarse-provisioning';

const PREFIX = 'inv1:';
const context = (tenantId: string) => `univarse:invite:${tenantId}`;

export async function sealInvite(provider: KeyProvider, tenantId: string, details: InviteDetails): Promise<string> {
  const key = randomBytes(32);
  try {
    const wrapped = await provider.wrap(key, context(tenantId));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context(tenantId), 'utf8'));
    const plain = Buffer.from(JSON.stringify({ displayName: details.displayName, email: details.email, username: details.username }), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return PREFIX + [wrapped, iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('|');
  } finally {
    key.fill(0);
  }
}

/** The details, or `unwrap_failed` for anything malformed, tampered with, or sealed for another institution. */
export async function openInvite(provider: KeyProvider, tenantId: string, sealed: string): Promise<InviteDetails> {
  const parts = sealed.startsWith(PREFIX) ? sealed.slice(PREFIX.length).split('|') : [];
  const [wrapped, iv, ct, tag] = parts;
  if (parts.length !== 4 || !wrapped || !iv || !ct || !tag) throw new KeyUnavailableError('unwrap_failed');
  const key = await provider.unwrap(wrapped, context(tenantId));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context(tenantId), 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    const v = JSON.parse(plain.toString('utf8')) as Partial<InviteDetails>;
    if (typeof v.displayName !== 'string' || typeof v.email !== 'string' || typeof v.username !== 'string') throw new Error('shape');
    return { displayName: v.displayName, email: v.email, username: v.username };
  } catch {
    throw new KeyUnavailableError('unwrap_failed');
  } finally {
    key.fill(0);
  }
}
