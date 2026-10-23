// Spec 0021 P4/P5: the page cursor holds only a row id; anything else decodes to nothing.
import { PageQuery } from '@univarse/contracts';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

const ID = '0192c7a4-1b2c-7d3e-8f40-123456789abc';

describe('[spec 0021] the page cursor', () => {
  it('[P4] round-trips a row id, and carries nothing else (no username: it travels in URLs)', () => {
    const c = encodeCursor(ID);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toBe(ID);
    expect(JSON.parse(Buffer.from(c, 'base64url').toString('utf8'))).toEqual({ v: 1, id: ID });
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['not JSON', Buffer.from('{oops', 'utf8').toString('base64url')],
    ['another version', Buffer.from(JSON.stringify({ v: 2, id: ID })).toString('base64url')],
    ['not a uuid', Buffer.from(JSON.stringify({ v: 1, id: 'x' })).toString('base64url')],
    ['an extra field', Buffer.from(JSON.stringify({ v: 1, id: ID, username: 'CSC/2021/001' })).toString('base64url')],
  ])('[P5] %s decodes to nothing', (_name, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});

describe('[spec 0021] the page query (docs/06: ?cursor=&limit=, at most 200)', () => {
  it.each([['1', 1], ['50', 50], ['199', 199], ['200', 200]])('[P2] limit %s is accepted', (raw, n) => {
    expect(PageQuery.parse({ limit: raw })).toEqual({ limit: n });
  });

  it.each(['0', '201', '999', '1000', '-1', '01', '1.5', '1e2', ' 5', 'abc', ''])('[P2] limit %j is refused', (raw) => {
    expect(PageQuery.safeParse({ limit: raw }).success).toBe(false);
  });

  it('[P2] no parameters is the first page; an unknown parameter is refused (strict); repeated values are refused', () => {
    expect(PageQuery.parse({})).toEqual({});
    expect(PageQuery.safeParse({ page: '2' }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: ['10', '20'] }).success).toBe(false);
    expect(PageQuery.safeParse({ cursor: 'a b' }).success).toBe(false);
  });
});
