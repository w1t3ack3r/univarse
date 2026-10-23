// Spec 0021: cursor pagination, as docs/06 §3 sets it (`?cursor=&limit=`, at most 200), for every list endpoint.
// The cursor is opaque to clients. The server encodes only the last row's id in it, never a value such as a
// username (a matric or staff number), because cursors travel in page URLs (CLAUDE.md invariant 8).
import { z } from 'zod';

export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

/** An opaque cursor as it travels: base64url, bounded. Its content is the server's business (shared/http/cursor.ts). */
export const Cursor = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).meta({ description: 'Opaque: the `nextCursor` of the previous page.' });

/**
 * A query string's limit, `1`–`200`: digits only (no sign, no leading zero, no decimals), parsed to a number. The
 * pattern itself admits exactly 1–200, so the published contract says what the server accepts.
 */
export const PageLimit = z
  .string()
  .regex(/^(?:200|1[0-9]{2}|[1-9][0-9]?)$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_PAGE_LIMIT))
  .meta({ description: `Rows per page, 1–${String(MAX_PAGE_LIMIT)}. Default ${String(DEFAULT_PAGE_LIMIT)}.` });

/** The query of a paged list. Strict: any other parameter is a 400 (docs/06 §2). */
export const PageQuery = z.object({ cursor: Cursor.optional(), limit: PageLimit.optional() }).strict();

/** docs/06 §3's `page`: `nextCursor` is null on the last page. */
export const Page = z
  .object({
    nextCursor: z.string().nullable(),
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT),
    hasMore: z.boolean(),
  })
  .strict();

/** A paged list of `row`: `{ data, page }`. */
export const paged = <T extends z.ZodType>(row: T) => z.object({ data: z.array(row), page: Page }).strict();
