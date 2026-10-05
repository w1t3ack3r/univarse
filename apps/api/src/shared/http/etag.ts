// Optimistic concurrency for editable resources (docs/06 §ETag; first used by settings, spec 0007 ST6).
import { ProblemError } from '../errors/problem.js';

export const etagOf = (version: number) => `"v${String(version)}"`;

/**
 * The version a write was based on, from `If-Match`. Missing → 428; anything that isn't one of our
 * ETags → 412 (it can't match the current version).
 */
export function requireIfMatch(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new ProblemError(428, 'precondition.required', 'Precondition required', 'Send If-Match with the ETag you read.');
  const m = /^(?:W\/)?"v(0|[1-9]\d{0,9})"$/.exec(raw.trim());
  if (!m) throw stale();
  return Number(m[1]);
}

export const stale = () => new ProblemError(412, 'precondition.failed', 'Precondition failed', 'The resource changed since you read it.');
