// Spec 0010 FU5: content checks. Pure functions: the type is detected from the actual bytes; the
// declared MIME type and the file name's extension must agree with it.

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // "5 MB" (docs/08 §7, spec 0010 D3)

export type AllowedType = 'application/pdf' | 'image/png' | 'image/jpeg';

const EXTENSIONS: Record<AllowedType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
};

export const isAllowedType = (mime: string): mime is AllowedType => Object.hasOwn(EXTENSIONS, mime);

const startsWith = (buf: Uint8Array, sig: readonly number[]) => sig.every((b, i) => buf[i] === b);

/** The type the bytes actually are, from magic numbers; null when it isn't one we allow. */
export function detectType(buf: Uint8Array): AllowedType | null {
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

const extensionOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? '').toLowerCase();

/** At the slot: the declared type is allowed and the name's extension matches it. */
export function declaredTypeProblem(name: string, mime: string): 'type_not_allowed' | 'type_mismatch' | null {
  if (!isAllowedType(mime)) return 'type_not_allowed';
  return EXTENSIONS[mime].includes(extensionOf(name)) ? null : 'type_mismatch';
}

/** After upload: what the bytes are must equal what was declared. */
export function contentProblem(buf: Uint8Array, declared: string): { detected: AllowedType | null; problem: 'type_not_allowed' | 'type_mismatch' | null } {
  const detected = detectType(buf);
  if (!detected) return { detected, problem: 'type_not_allowed' };
  return { detected, problem: detected === declared ? null : 'type_mismatch' };
}

/**
 * A display name safe for storage and for `Content-Disposition`: no path parts, no control
 * characters, bounded length. The original stays only as metadata, never as a storage key.
 */
export function sanitiseFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').replace(/\s+/g, ' ').trim();
  const bounded = clean.length > 120 ? `${clean.slice(0, 100)}…${clean.slice(-15)}` : clean;
  return bounded || 'document';
}

/** RFC 6266/5987: `attachment; filename="ascii"; filename*=UTF-8''pct-encoded`. */
export function contentDisposition(name: string): string {
  const safe = sanitiseFileName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
