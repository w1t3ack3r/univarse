// Spec 0021 P4: a page cursor holds only the last row's id, never a value from the row (a username is a matric or
// staff number, and cursors travel in page URLs: CLAUDE.md invariant 8). The list looks the row up again, under the
// tenant's RLS, to find where the next page starts. RLS keeps a cursor within its institution, so it needs no
// signature: a cursor that doesn't decode, or names a row this tenant can't see, is refused the same way.
import { z } from 'zod';

const Payload = z.object({ v: z.literal(1), id: z.uuid() }).strict();

export function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, id }), 'utf8').toString('base64url');
}

/** The row id a cursor names, or null when it isn't one of ours. */
export function decodeCursor(cursor: string): string | null {
  try {
    const r = Payload.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return r.success ? r.data.id : null;
  } catch {
    return null;
  }
}
