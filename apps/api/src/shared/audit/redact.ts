// Audit payload redaction (spec 0002 A6). Applied to before/after/metadata before hashing and storage.
// Deny-by-pattern on key names, recursively. Values under a matching key are replaced wholesale.

const SECRET_KEY = /password|passcode|pass_?phrase|secret|token|code|recovery|hash|pepper|otp|pin|cookie|authorization/i;

export const REDACTED = '[REDACTED]';

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Date || value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v);
  }
  return out;
}
