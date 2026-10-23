// Shared test tooling: PostgreSQL's lexing, and the bound-parameter proof, for the API's SQL guards (spec 0017's
// PB4 session-SQL guard). Written for spec 0015's CI10 guard (owner reviews of #66) and moved here when CI10 was
// retired (spec 0022); unchanged. Test tooling: excluded from the build.
import { createRequire } from 'node:module';
import type * as TS from 'typescript';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TS;

/** A SQL token: words are case-folded (as PostgreSQL folds them); identifiers and strings are decoded. */
export interface SqlToken {
  readonly kind: 'word' | 'ident' | 'string' | 'other';
  readonly value: string;
}

const SQL_SPACE = /[ \t\n\r\f\v]/;
const WORD = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Lexes SQL as PostgreSQL's scanner does (scan.l), into tokens with every literal DECODED:
 * - whitespace and comments separate tokens; a `--` comment ends at LF or CR, and block comments nest;
 * - `"…"` identifiers (`""` escapes) become one identifier token, so `UPDATE"tenant"` is two tokens;
 * - standard `'…'` strings (`''` escapes), `E'…'` strings with every backslash escape decoded (`\b \f \n \r \t`,
 *   octal, `\xhh`, `\uXXXX`, `\UXXXXXXXX`, any other character itself), and dollar-quoted strings;
 * - adjacent string constants separated only by whitespace or comments are joined, as PostgreSQL joins them across
 *   a newline (joining where PostgreSQL would raise a syntax error instead is harmless);
 * - REFUSED (an error): `U&'…'` / `U&"…"` (their `UESCAPE` character makes decoding context-dependent), a backslash
 *   in a standard string (its meaning depends on standard_conforming_strings), and anything unterminated.
 */
export function lexSql(text: string): { tokens: SqlToken[] } | { error: string } {
  const tokens: SqlToken[] = [];
  const n = text.length;
  /** Skips whitespace and comments from j: the next token's index, or -1 for an unterminated block comment. */
  const skipGap = (from: number): number => {
    let j = from;
    for (;;) {
      if (j < n && SQL_SPACE.test(text[j]!)) j++;
      else if (text.startsWith('--', j)) {
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
      } else if (text.startsWith('/*', j)) {
        let depth = 0;
        do {
          if (j >= n) return -1;
          if (text.startsWith('/*', j)) {
            depth++;
            j += 2;
          } else if (text.startsWith('*/', j)) {
            depth--;
            j += 2;
          } else j++;
        } while (depth > 0);
      } else return j;
    }
  };
  /** Reads a quoted constant whose opening quote is at `from`: [decoded value, index after the closing quote]. */
  const readQuoted = (from: number, escapes: boolean): [string, number] | string => {
    let j = from + 1;
    let s = '';
    for (;;) {
      if (j >= n) return 'an unterminated string';
      const ch = text[j]!;
      if (ch === "'") {
        if (text[j + 1] !== "'") return [s, j + 1];
        s += "'";
        j += 2;
      } else if (ch !== '\\') {
        s += ch;
        j++;
      } else if (!escapes) {
        return 'a backslash in a standard string (its meaning depends on standard_conforming_strings)';
      } else {
        const e = text[j + 1];
        if (e === undefined) return 'an unterminated string';
        const simple = ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[
          e
        ];
        const octal = /^[0-7]{1,3}/.exec(text.slice(j + 1, j + 4))?.[0];
        const hex = e === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(text.slice(j + 2, j + 4))?.[0] : undefined;
        if (simple !== undefined) {
          s += simple;
          j += 2;
        } else if (octal) {
          s += String.fromCharCode(parseInt(octal, 8) & 0xff);
          j += 1 + octal.length;
        } else if (hex) {
          s += String.fromCharCode(parseInt(hex, 16));
          j += 2 + hex.length;
        } else if (e === 'u' || e === 'U') {
          const len = e === 'u' ? 4 : 8;
          const digits = text.slice(j + 2, j + 2 + len);
          const cp =
            /^[0-9A-Fa-f]+$/.test(digits) && digits.length === len ? parseInt(digits, 16) : NaN;
          if (!(cp <= 0x10ffff)) return 'an invalid Unicode escape';
          s += String.fromCodePoint(cp);
          j += 2 + len;
        } else {
          s += e;
          j += 2;
        }
      }
    }
  };
  let i = 0;
  while (i < n) {
    const g = skipGap(i);
    if (g < 0) return { error: 'an unterminated comment' };
    if (g >= n) break;
    i = g;
    const rest = text.slice(i, i + 3);
    if (/^[uU]&['"]/.test(rest)) {
      return {
        error:
          'a U&… Unicode-escape constant or identifier (its UESCAPE makes decoding context-dependent)',
      };
    }
    const prefix = /^([eEnNbBxX])'/.exec(rest)?.[1];
    if (prefix !== undefined || text[i] === "'") {
      // A string constant, then any constants joined to it; E'…' continuations keep the escape rules.
      const escapes = prefix === 'e' || prefix === 'E';
      let at = prefix === undefined ? i : i + 1;
      let value = '';
      const pieces: string[] = [];
      for (;;) {
        const r = readQuoted(at, escapes);
        if (typeof r === 'string') return { error: r };
        pieces.push(r[0]);
        value += r[0];
        const next = skipGap(r[1]);
        if (next < 0) return { error: 'an unterminated comment' };
        if (text[next] !== "'") {
          i = r[1];
          break;
        }
        at = next;
      }
      tokens.push({ kind: 'string', value });
      if (pieces.length > 1) for (const p of pieces) tokens.push({ kind: 'string', value: p });
      continue;
    }
    if (text[i] === '"') {
      let j = i + 1;
      let ident = '';
      for (;;) {
        if (j >= n) return { error: 'an unterminated quoted identifier' };
        if (text[j] === '"') {
          if (text[j + 1] !== '"') break;
          ident += '"';
          j += 2;
        } else ident += text[j++]!;
      }
      tokens.push({ kind: 'ident', value: ident });
      i = j + 1;
      continue;
    }
    const tag = text[i] === '$' ? DOLLAR_TAG.exec(text.slice(i))?.[0] : undefined;
    if (tag) {
      const end = text.indexOf(tag, i + tag.length);
      if (end < 0) return { error: 'an unterminated dollar-quoted string' };
      tokens.push({ kind: 'string', value: text.slice(i + tag.length, end) });
      i = end + tag.length;
      continue;
    }
    const word = WORD.exec(text.slice(i))?.[0];
    if (word) {
      tokens.push({ kind: 'word', value: word.toLowerCase() });
      i += word.length;
      continue;
    }
    const other = /^(\$[0-9]+|[0-9][0-9A-Za-z_.]*)/.exec(text.slice(i))?.[0] ?? text[i]!;
    tokens.push({ kind: 'other', value: other });
    i += other.length;
  }
  return { tokens };
}

/**
 * The bound-parameter proof (spec 0017's PB4 check; written for spec 0015's CI10 guard): whether every value of a type
 * is sent as a bound parameter, never spliced in as SQL.
 */
export function boundParameterOf(program: TS.Program): (t: TS.Type) => boolean {
  const checker = program.getTypeChecker();
  /**
   * Whether every value of `t` is sent as a bound parameter, never spliced in as SQL: every member of a union, the
   * constraint of a type parameter, and the elements of an array must be a primitive (literal types and enums
   * included) or Date. Intersections pass only as a branded primitive, `string & { … }`.
   */
  const PRIMITIVE =
    ts.TypeFlags.StringLike |
    ts.TypeFlags.NumberLike |
    ts.TypeFlags.BigIntLike |
    ts.TypeFlags.BooleanLike |
    ts.TypeFlags.EnumLike |
    ts.TypeFlags.Null |
    ts.TypeFlags.Undefined;
  const boundParameter = (t: TS.Type, depth = 0): boolean => {
    if (depth > 8) return false;
    if (t.flags & PRIMITIVE) return true;
    if (t.flags & ts.TypeFlags.TypeParameter) {
      const c = checker.getBaseConstraintOfType(t);
      return !!c && c !== t && boundParameter(c, depth + 1);
    }
    if (t.isUnion()) return t.types.every((m) => boundParameter(m, depth + 1));
    if (t.isIntersection()) {
      return (
        t.types.some((m) => (m.flags & PRIMITIVE) !== 0) &&
        t.types.every((m) => (m.flags & PRIMITIVE) !== 0 || brand(m))
      );
    }
    if (checker.isArrayType(t) || checker.isTupleType(t))
      return checker
        .getTypeArguments(t as TS.TypeReference)
        .every((e) => boundParameter(e, depth + 1));
    const sym = t.getSymbol();
    return (
      sym?.getName() === 'Date' &&
      (sym.declarations ?? []).some((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
    );
  };
  /** A brand: an anonymous object type whose properties are all primitives (no methods, nothing SQL-shaped). */
  const brand = (t: TS.Type) =>
    !!(t.flags & ts.TypeFlags.Object) &&
    !!t.getSymbol() &&
    t.getSymbol()!.getName() === '__type' &&
    t.getCallSignatures().length === 0 &&
    t.getProperties().every((p) => {
      const pt = checker.getTypeOfSymbol(p);
      return (pt.flags & (PRIMITIVE | ts.TypeFlags.UniqueESSymbol)) !== 0;
    });
  return boundParameter;
}
