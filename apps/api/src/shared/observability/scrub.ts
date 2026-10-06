// Spec 0012 OB4/OB5: secrets inside STRINGS. Pino's `redact` only sees object paths; these patterns
// clean free text (log messages, error messages and stacks, and later span attributes and exception
// events). Each pattern has its own unit test.

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Query strings: a URL keeps origin + path only (absolute, or an /api path).
  [/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1'],
  [/(\/api\/[^\s?#"'<>]*)\?[^\s"'<>]*/g, '$1'],
  // Header values written out in text.
  [/\b(cookie|set-cookie|authorization|proxy-authorization)(\s*[:=]\s*)[^\r\n]*/gi, '$1$2[redacted]'],
  // Our cookies, wherever they appear.
  [/\b(__Host-uv_[a-z]+)=[^;\s,"']*/g, '$1=[redacted]'],
  // Bearer tokens.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  // Signed storage credentials (presigned POST fields, query or JSON form).
  [/\b(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Policy)(["']?\s*[:=]\s*["']?)[^"'&\s,}]+/g, '$1$2[redacted]'],
];

/** Quoted literals, as in SQL or driver errors: values must not reach logs or traces. */
const QUOTED = /'(?:[^'\\]|\\.|'')*'/g;

/** Free text written by our code: URLs, headers, cookies, tokens, signed credentials. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, by] of PATTERNS) out = out.replace(re, by);
  return out;
}

/** Text we didn't write (error messages and stacks from drivers): also hides quoted literals. */
export function scrubForeign(text: string): string {
  return scrub(text).replace(QUOTED, "'?'");
}
