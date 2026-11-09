/**
 * Spec 0033: the rules of the tenant registry. Pure, so they're tested without a database. An institution's differences
 * are its settings; these rules are the same for every institution.
 */
export type TenantTypeName = 'UNIVERSITY' | 'POLYTECHNIC' | 'COLLEGE_OF_EDUCATION';
export type TenantStatusName = 'REQUESTED' | 'PROVISIONING' | 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'OFFBOARDING' | 'ARCHIVED' | 'PURGED';
export type Regulator = 'NUC' | 'NBTE' | 'NCCE';

const REGULATORS: Readonly<Record<TenantTypeName, Regulator>> = Object.freeze({ UNIVERSITY: 'NUC', POLYTECHNIC: 'NBTE', COLLEGE_OF_EDUCATION: 'NCCE' });

/** Q7: derived, so the regulator can never disagree with the type. */
export const regulatorForType = (type: TenantTypeName): Regulator => REGULATORS[type];

const BEFORE_LIVE: ReadonlySet<TenantStatusName> = new Set(['REQUESTED', 'PROVISIONING', 'ONBOARDING']);

/** Q6: the type picks the regulator and, from S5, the grading rules. Under live results it isn't an edit. */
export const typeMayChange = (status: TenantStatusName): boolean => BEFORE_LIVE.has(status);

/** An institution whose data is gone or going away can't be edited: there's nothing left to describe. */
export const registryWritable = (status: TenantStatusName): boolean => status !== 'ARCHIVED' && status !== 'PURGED';

// ── Colour (Q10)

const WHITE = '#FFFFFF';
/** The deep brand ink: the other text colour a primary colour may carry. */
export const BRAND_INK = '#485550';
export const MIN_CONTRAST = 4.5;

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG's contrast ratio of two `#RRGGBB` colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Q10: the text colour a primary colour carries, or null if neither reaches 4.5:1 and the colour is refused. */
export function textColorOn(primary: string): typeof WHITE | typeof BRAND_INK | null {
  const onWhite = contrastRatio(primary, WHITE);
  const onInk = contrastRatio(primary, BRAND_INK);
  if (onWhite < MIN_CONTRAST && onInk < MIN_CONTRAST) return null;
  return onWhite >= onInk ? WHITE : BRAND_INK;
}

// ── The logo (Q9): judged from the file's own bytes, never its name or a declared type.

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MAX_DIMENSION = 1024;
export type LogoMime = 'image/png' | 'image/webp';
export type LogoProblem = 'too_large' | 'not_png_or_webp' | 'too_many_pixels';
export type LogoCheck = { readonly ok: true; readonly mime: LogoMime; readonly width: number; readonly height: number } | { readonly ok: false; readonly problem: LogoProblem };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u24le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] ?? 0) * 0x1000000) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 33 || !PNG_SIGNATURE.every((v, i) => b[i] === v) || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  switch (ascii(b, 12, 4)) {
    case 'VP8X':
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    case 'VP8L':
      if (b[20] !== 0x2f) return null;
      return {
        width: (((b[22] ?? 0) & 0x3f) << 8 | (b[21] ?? 0)) + 1,
        height: (((b[24] ?? 0) & 0x0f) << 10 | (b[23] ?? 0) << 2 | ((b[22] ?? 0) & 0xc0) >> 6) + 1,
      };
    case 'VP8 ':
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return { width: ((b[27] ?? 0) << 8 | (b[26] ?? 0)) & 0x3fff, height: ((b[29] ?? 0) << 8 | (b[28] ?? 0)) & 0x3fff };
    default:
      return null;
  }
}

/** Q9: PNG or WebP, 256 KB, 1024 × 1024. An SVG, whatever it's called, is neither. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, problem: 'too_large' };
  const png = pngSize(bytes);
  const size = png ?? webpSize(bytes);
  if (!size || size.width === 0 || size.height === 0) return { ok: false, problem: 'not_png_or_webp' };
  if (size.width > LOGO_MAX_DIMENSION || size.height > LOGO_MAX_DIMENSION) return { ok: false, problem: 'too_many_pixels' };
  return { ok: true, mime: png ? 'image/png' : 'image/webp', ...size };
}
