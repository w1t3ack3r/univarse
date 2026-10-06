// Spec 0010: the pure pieces. The real-service behaviour is in files.int.spec.ts.
import { describe, expect, it } from 'vitest';
import { parseClamdReply, ScannerUnavailable } from './clamd-scanner.js';
import { contentDisposition, contentProblem, declaredTypeProblem, detectType, sanitiseFileName } from './file-types.js';

describe('[FU3][FU16] clamd replies', () => {
  it('only an explicit "stream: OK" is clean', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ verdict: 'clean' });
  });

  it('any "<signature> FOUND" is infected, whatever the signature (no test-specific logic)', () => {
    for (const sig of ['Eicar-Test-Signature', 'UniVarse.Test.Marker-1.UNOFFICIAL', 'Heuristics.Encrypted.PDF', 'Heuristics.Limits.Exceeded.MaxFileSize']) {
      expect(parseClamdReply(`stream: ${sig} FOUND\0`)).toEqual({ verdict: 'infected', signature: sig });
    }
  });

  it('everything else is a failure to scan, never clean', () => {
    for (const reply of ['INSTREAM size limit exceeded. ERROR', 'stream: OK and more', 'stream: maybe?', '', 'OK', 'stream:  FOUND']) {
      expect(() => parseClamdReply(reply)).toThrow(ScannerUnavailable);
    }
  });
});

describe('[FU5] content checks', () => {
  const pdf = Buffer.from('%PDF-1.7\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  it('detects the type from the bytes, not the name', () => {
    expect([detectType(pdf), detectType(png), detectType(jpg), detectType(Buffer.from('GIF89a'))]).toEqual(['application/pdf', 'image/png', 'image/jpeg', null]);
  });

  it('declared type must be allowed and match the extension', () => {
    expect(declaredTypeProblem('a.pdf', 'application/pdf')).toBeNull();
    expect(declaredTypeProblem('a.JPEG', 'image/jpeg')).toBeNull();
    expect(declaredTypeProblem('a.png', 'application/pdf')).toBe('type_mismatch');
    expect(declaredTypeProblem('a.svg', 'image/svg+xml')).toBe('type_not_allowed');
  });

  it('bytes must be what was declared', () => {
    expect(contentProblem(png, 'application/pdf')).toEqual({ detected: 'image/png', problem: 'type_mismatch' });
    expect(contentProblem(Buffer.from('MZ'), 'application/pdf')).toEqual({ detected: null, problem: 'type_not_allowed' });
    expect(contentProblem(pdf, 'application/pdf')).toEqual({ detected: 'application/pdf', problem: null });
  });

  it('names are safe for storage and headers: no paths, controls, quotes or header injection', () => {
    expect(sanitiseFileName('..\\..\\etc/passwd')).toBe('passwd');
    expect(sanitiseFileName('Report "Q3"\r\nX-Evil: 1.pdf')).toBe('Report Q3X-Evil 1.pdf');
    expect(sanitiseFileName('   ')).toBe('document');
    expect(contentDisposition('Résumé 2026.pdf')).toBe(`attachment; filename="R_sum_ 2026.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%202026.pdf`);
  });
});
