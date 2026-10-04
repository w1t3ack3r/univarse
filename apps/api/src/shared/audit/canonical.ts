// Canonical JSON for hashing (spec 0002 A9): recursively sorted keys, ISO-8601 UTC dates,
// bigint as decimal strings, undefined dropped. The same logical value always yields the same string.

export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite numbers cannot be canonicalised');
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
