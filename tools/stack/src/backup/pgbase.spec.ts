import { describe, expect, it } from 'vitest';
import { startOf, walFileName } from './pgbase.js';

describe('walFileName', () => {
  it('names the segment holding an LSN, as PostgreSQL does', () => {
    // From a real run (PostgreSQL 16): "start point: 0/4000028" with backup_label "(file 000000010000000000000004)".
    expect(walFileName('0/4000028', 1)).toBe('000000010000000000000004');
    expect(walFileName('0/FFFFFFF', 1)).toBe('00000001000000000000000F');
    expect(walFileName('0/FF000000', 2)).toBe('0000000200000000000000FF');
    expect(walFileName('1/0', 2)).toBe('000000020000000100000000');
    expect(walFileName('1A/3F000010', 12)).toBe('0000000C0000001A0000003F');
  });

  it('refuses what is not an LSN', () => {
    expect(() => walFileName('0-4', 1)).toThrow(/bad LSN/);
    expect(() => walFileName('0/4', 0)).toThrow(/bad LSN/);
  });
});

describe('startOf', () => {
  it("reads pg_basebackup -v's report", () => {
    const stderr = [
      'pg_basebackup: initiating base backup, waiting for checkpoint to complete',
      'pg_basebackup: checkpoint completed',
      'pg_basebackup: write-ahead log start point: 0/5000028 on timeline 1',
      'pg_basebackup: write-ahead log end point: 0/5000100',
    ].join('\n');
    expect(startOf(stderr)).toEqual({ lsn: '0/5000028', timeline: 1, startWal: '000000010000000000000005' });
  });

  it('refuses output without the start point', () => {
    expect(() => startOf('pg_basebackup: error: connection failed')).toThrow(/start point/);
  });
});
