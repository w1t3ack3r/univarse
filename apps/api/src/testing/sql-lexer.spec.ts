// The SQL lexer, tested directly (spec 0022): when CI10 was retired, its raw-SQL fixtures went with it, and these keep
// the lexer's edge cases covered for the guards still built on it (spec 0017's PB4 session-SQL guard).
import { describe, expect, it } from 'vitest';
import { lexSql, type SqlToken } from './sql-lexer.js';

const tokens = (text: string): SqlToken[] => {
  const r = lexSql(text);
  if ('error' in r) throw new Error(r.error);
  return r.tokens;
};
const values = (text: string) => tokens(text).map((t) => `${t.kind}:${t.value}`);
const error = (text: string) => {
  const r = lexSql(text);
  return 'error' in r ? r.error : null;
};

describe('lexSql', () => {
  it('folds words, and keeps a quoted identifier its own token (UPDATE"tenant" is two tokens)', () => {
    expect(values('UPDATE"tenant"')).toEqual(['word:update', 'ident:tenant']);
    expect(values('SELECT "a""b"')).toEqual(['word:select', 'ident:a"b']);
  });

  it.each([
    ['LF', 'SELECT 1 -- x\nUPDATE t'],
    ['CR', 'SELECT 1 -- x\rUPDATE t'],
    ['CRLF', 'SELECT 1 -- x\r\nUPDATE t'],
  ])('a line comment ends at %s', (_name, text) => {
    expect(values(text)).toContain('word:update');
  });

  it('block comments nest: the text after the inner close is still a comment', () => {
    expect(values('SELECT /* a /* b */ UPDATE */ 1')).toEqual(['word:select', 'other:1']);
    expect(error('SELECT /* a /* b */')).toMatch(/unterminated/);
  });

  it('decodes every literal form: standard, E-escapes (octal, \\x, \\u, \\U), and dollar quotes', () => {
    expect(values("SELECT 'it''s'")).toEqual(['word:select', "string:it's"]);
    expect(values(String.raw`SELECT E'\x53\123E\U00000054'`)).toEqual(['word:select', 'string:SSET']);
    expect(values('SELECT $$UPDATE tenant$$, $q$x$q$')).toEqual(['word:select', 'string:UPDATE tenant', 'other:,', 'string:x']);
  });

  it('joins adjacent string constants across a newline, as PostgreSQL does, and keeps each piece too', () => {
    // The joined constant first, then its pieces: a guard sees every way the text can be read.
    expect(values("SELECT 'UPD'\n'ATE'")).toEqual(['word:select', 'string:UPDATE', 'string:UPD', 'string:ATE']);
    expect(values("SELECT 'UPD' /* c */ 'ATE'")).toEqual(['word:select', 'string:UPDATE', 'string:UPD', 'string:ATE']);
  });

  it.each([
    ['a U& string', "SELECT U&'\\0053ET'", /U&/],
    ['a U& identifier', 'SELECT U&"\\0074enant"', /U&/],
    ['a backslash in a standard string', "SELECT 'a\\b'", /backslash/],
    ['an unterminated string', "SELECT 'open", /unterminated/],
    ['an unterminated dollar quote', 'SELECT $$open', /unterminated/],
    ['an unterminated identifier', 'SELECT "open', /unterminated/],
  ])('refuses %s', (_name, text, why) => {
    expect(error(text)).toMatch(why);
  });
});
