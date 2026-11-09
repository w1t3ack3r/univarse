import { describe, expect, it } from 'vitest';
import { BRAND_INK, checkLogo, contrastRatio, LOGO_MAX_BYTES, regulatorForType, registryWritable, textColorOn, typeMayChange } from './tenant-registry.js';

function png(width: number, height: number, length = 64): Uint8Array {
  const b = new Uint8Array(length);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function webp(fourcc: string, fill: (b: Uint8Array) => void): Uint8Array {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode('RIFF'), 0);
  b.set(new TextEncoder().encode('WEBP'), 8);
  b.set(new TextEncoder().encode(fourcc), 12);
  fill(b);
  return b;
}

describe('the regulator and the type (spec 0033 Q6, Q7)', () => {
  it('follows the type', () => {
    expect(regulatorForType('UNIVERSITY')).toBe('NUC');
    expect(regulatorForType('POLYTECHNIC')).toBe('NBTE');
    expect(regulatorForType('COLLEGE_OF_EDUCATION')).toBe('NCCE');
  });

  it('the type may change only before an institution is live', () => {
    for (const s of ['REQUESTED', 'PROVISIONING', 'ONBOARDING'] as const) expect([s, typeMayChange(s)]).toEqual([s, true]);
    for (const s of ['ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED', 'PURGED'] as const) expect([s, typeMayChange(s)]).toEqual([s, false]);
  });

  it('nothing edits an institution that’s archived or purged', () => {
    expect(registryWritable('ACTIVE')).toBe(true);
    expect(registryWritable('SUSPENDED')).toBe(true);
    expect(registryWritable('ARCHIVED')).toBe(false);
    expect(registryWritable('PURGED')).toBe(false);
  });
});

describe('colour (Q10)', () => {
  it('computes WCAG’s ratio', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('picks the text colour that reads best', () => {
    expect(textColorOn('#1A3A6B')).toBe('#FFFFFF');
    expect(textColorOn('#F7E27A')).toBe(BRAND_INK);
  });

  it('refuses a colour that neither text colour can read on', () => {
    expect(textColorOn('#888F8C')).toBeNull();
  });

  it('accepts exactly at the line and refuses just under it', () => {
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(textColorOn('#767676')).toBe('#FFFFFF');
  });
});

describe('the logo, from its own bytes (Q9)', () => {
  it('reads a PNG', () => {
    expect(checkLogo(png(512, 256))).toEqual({ ok: true, mime: 'image/png', width: 512, height: 256 });
  });

  it('reads all three WebP layouts', () => {
    const vp8x = webp('VP8X', (b) => {
      b.set([99, 0, 0], 24); // width - 1
      b.set([49, 0, 0], 27);
    });
    expect(checkLogo(vp8x)).toEqual({ ok: true, mime: 'image/webp', width: 100, height: 50 });
    const lossy = webp('VP8 ', (b) => {
      b.set([0x9d, 0x01, 0x2a], 23);
      b.set([100, 0, 50, 0], 26);
    });
    expect(checkLogo(lossy)).toEqual({ ok: true, mime: 'image/webp', width: 100, height: 50 });
    const lossless = webp('VP8L', (b) => {
      b[20] = 0x2f;
      b.set([99, 0x40, 0x0c, 0], 21); // width 100, height 50
    });
    expect(checkLogo(lossless)).toEqual({ ok: true, mime: 'image/webp', width: 100, height: 50 });
  });

  it('refuses a WebP whose layout marker is wrong or unknown', () => {
    expect(checkLogo(webp('VP8L', (b) => (b[20] = 0)))).toEqual({ ok: false, problem: 'not_png_or_webp' });
    expect(checkLogo(webp('VP8 ', (b) => (b[23] = 0)))).toEqual({ ok: false, problem: 'not_png_or_webp' });
    expect(checkLogo(webp('XXXX', () => undefined))).toEqual({ ok: false, problem: 'not_png_or_webp' });
  });

  it('refuses a RIFF that isn’t a WebP, and a PNG with no header chunk', () => {
    const riff = webp('VP8X', () => undefined);
    riff[8] = 0x41;
    expect(checkLogo(riff)).toEqual({ ok: false, problem: 'not_png_or_webp' });
    const noHeader = png(10, 10);
    noHeader[12] = 0;
    expect(checkLogo(noHeader)).toEqual({ ok: false, problem: 'not_png_or_webp' });
  });

  it('refuses an SVG, whatever it claims', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(checkLogo(svg)).toEqual({ ok: false, problem: 'not_png_or_webp' });
  });

  it('refuses a truncated header, and a zero-sized image', () => {
    expect(checkLogo(png(10, 10).subarray(0, 20))).toEqual({ ok: false, problem: 'not_png_or_webp' });
    expect(checkLogo(png(0, 10))).toEqual({ ok: false, problem: 'not_png_or_webp' });
    expect(checkLogo(new Uint8Array(0))).toEqual({ ok: false, problem: 'not_png_or_webp' });
  });

  it('holds the size and dimension limits, at the line', () => {
    expect(checkLogo(png(1024, 1024)).ok).toBe(true);
    expect(checkLogo(png(1025, 10))).toEqual({ ok: false, problem: 'too_many_pixels' });
    expect(checkLogo(png(10, 1025))).toEqual({ ok: false, problem: 'too_many_pixels' });
    expect(checkLogo(png(10, 10, LOGO_MAX_BYTES)).ok).toBe(true);
    expect(checkLogo(png(10, 10, LOGO_MAX_BYTES + 1))).toEqual({ ok: false, problem: 'too_large' });
  });
});
