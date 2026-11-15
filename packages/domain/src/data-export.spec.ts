import { describe, expect, it } from 'vitest';
import {
  archiveFileName,
  exportableStatus,
  exportDownloadable,
  exportExpiresAt,
  exportRequestProblem,
  nextExportAllowedAt,
  PASSPHRASE_ALPHABET,
  PASSPHRASE_PATTERN,
  passphraseFrom,
  type ExportState,
} from './data-export.js';

const HOUR = 3_600_000;
const now = new Date('2026-11-20T10:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * HOUR);

describe('the export (spec 0038 Q7, Q8)', () => {
  it('is requested while the institution is served only', () => {
    const all = ['REQUESTED', 'PROVISIONING', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED', 'PURGED'];
    expect(all.filter(exportableStatus)).toEqual(['ONBOARDING', 'ACTIVE', 'OFFBOARDING']);
  });

  it('is one at a time (Q-B5)', () => {
    for (const state of ['REQUESTED', 'BUILDING'] as ExportState[]) {
      expect(exportRequestProblem([{ state, requestedAt: ago(48) }], now)).toBe('export.in_progress');
    }
    expect(exportRequestProblem([], now)).toBeNull();
  });

  it('is at most one a day, unless the last one failed (Q-B5)', () => {
    expect(exportRequestProblem([{ state: 'READY', requestedAt: ago(23) }], now)).toBe('export.too_soon');
    expect(exportRequestProblem([{ state: 'EXPIRED', requestedAt: ago(23.99) }], now)).toBe('export.too_soon');
    expect(exportRequestProblem([{ state: 'READY', requestedAt: ago(24) }], now)).toBeNull();
    expect(exportRequestProblem([{ state: 'FAILED', requestedAt: ago(1) }], now)).toBeNull();
    expect(exportRequestProblem([{ state: 'FAILED', requestedAt: ago(1) }, { state: 'READY', requestedAt: ago(2) }], now)).toBe('export.too_soon');
  });

  it('says when the next one is allowed', () => {
    expect(nextExportAllowedAt([{ state: 'READY', requestedAt: ago(20) }, { state: 'READY', requestedAt: ago(30) }], now)).toEqual(new Date(now.getTime() + 4 * HOUR));
    expect(nextExportAllowedAt([{ state: 'READY', requestedAt: ago(30) }], now)).toBeNull();
    expect(nextExportAllowedAt([{ state: 'BUILDING', requestedAt: ago(1) }], now)).toBeNull();
  });

  it('is kept 7 days, and downloads only while ready and not expired', () => {
    const readyAt = new Date('2026-11-20T10:00:00Z');
    const expiresAt = exportExpiresAt(readyAt);
    expect(expiresAt.toISOString()).toBe('2026-11-27T10:00:00.000Z');
    expect(exportDownloadable({ state: 'READY', expiresAt }, new Date(expiresAt.getTime() - 1))).toBe(true);
    expect(exportDownloadable({ state: 'READY', expiresAt }, expiresAt)).toBe(false);
    for (const state of ['REQUESTED', 'BUILDING', 'FAILED', 'EXPIRED'] as ExportState[]) {
      expect(exportDownloadable({ state, expiresAt }, readyAt)).toBe(false);
    }
    expect(exportDownloadable({ state: 'READY', expiresAt: null }, readyAt)).toBe(false);
  });
});

describe('the passphrase (Q-B4)', () => {
  it('is six groups of five from Crockford base 32, one symbol a byte, so 150 bits', () => {
    const p = passphraseFrom(Uint8Array.from({ length: 30 }, (_, i) => i * 8 + 1));
    expect(p).toMatch(PASSPHRASE_PATTERN);
    expect(p.replaceAll('-', '')).toHaveLength(30);
    expect(PASSPHRASE_ALPHABET).toHaveLength(32);
    expect(PASSPHRASE_ALPHABET).not.toMatch(/[ILOU]/);
  });

  it('uses every symbol, each from the byte\'s low five bits', () => {
    const p = passphraseFrom(Uint8Array.from({ length: 30 }, (_, i) => i + 32)).replaceAll('-', '');
    expect(p).toBe(PASSPHRASE_ALPHABET.slice(0, 30));
    expect(passphraseFrom(new Uint8Array(30).fill(0xff)).replaceAll('-', '')).toBe('Z'.repeat(30));
  });

  it('refuses too few random bytes', () => {
    expect(() => passphraseFrom(new Uint8Array(29))).toThrow();
  });
});

describe('a file\'s name in the archive (Q-B2)', () => {
  const id = '0196f3a2-1b2c-7d3e-8f40-123456789abc';

  it('keeps an ordinary name under the file\'s own folder', () => {
    expect(archiveFileName(id, 'Transcript 2025.pdf')).toBe(`files/${id}/Transcript 2025.pdf`);
  });

  it('is never a path, a hidden name or a name Windows refuses', () => {
    expect(archiveFileName(id, '../../etc/passwd')).toBe(`files/${id}/_.._etc_passwd`);
    expect(archiveFileName(id, '..\\..\\boot.ini')).toBe(`files/${id}/_.._boot.ini`);
    expect(archiveFileName(id, 'a:b*c?.txt')).toBe(`files/${id}/a_b_c_.txt`);
    expect(archiveFileName(id, '.htaccess')).toBe(`files/${id}/htaccess`);
    expect(archiveFileName(id, 'name. ')).toBe(`files/${id}/name`);
    expect(archiveFileName(id, '...')).toBe(`files/${id}/file`);
    expect(archiveFileName(id, '/')).toBe(`files/${id}/file`);
    expect(archiveFileName(id, 'a\u0000b\nc')).toBe(`files/${id}/a_b_c`);
  });

  it('is at most 120 characters, the extension kept', () => {
    const name = archiveFileName(id, `${'x'.repeat(300)}.pdf`).split('/')[2] ?? '';
    expect(name).toHaveLength(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('refuses an id that isn\'t one', () => {
    expect(() => archiveFileName('../x', 'a.pdf')).toThrow();
  });
});
