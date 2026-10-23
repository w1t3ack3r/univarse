# Spec 0021: `GET /users` pagination, and query parameters in the contract

**Status:** **Accepted (2026-10-23)** by the owner, P1–P8 as written. **Implemented** in one PR (below).
**Phase:** 0. A tracked gap in [18](../18-roadmap.md).
**Builds on:**

- [06 §3](../06-api-guidelines.md): collections are `{ data, page }`, paginated by cursor (`?cursor=&limit=`, at most 200);
- [spec 0011](0011-openapi-and-api-client.md): the contract, the OpenAPI document and the generated client;
- CLAUDE.md invariant 8: no PII in URLs.

## Why

`GET /api/v1/users` returned the first 50 users by username and stopped, with no way to reach the rest. A university has tens of thousands of accounts, so the Users page silently showed a sliver of them. docs/06 set the rule, but no endpoint followed it yet. This is the first, so its pattern (and the contract's query parameters, which didn't exist) is what every later list copies.

## Decisions

| # | Decision | Why |
| - | -------- | --- |
| P1 | **The response follows docs/06:** `{ data, page: { nextCursor, limit, hasMore } }`. No `meta.total`. | Counting tens of thousands of rows on every page isn't cheap, and docs/06 allows `total` only when it is. |
| P2 | **The query:** `?cursor=<opaque>&limit=<1–200>`, default 50. Anything out of range, or any other parameter, is a **400 `request.invalid`** with field errors. | Strict, like bodies (unknown fields rejected). |
| P3 | **The order:** by username, then id, each page read from the last row of the one before (keyset), never by skipping rows. | Stable while users are added, and fast at any depth. Usernames are unique per institution and indexed. |
| P4 | **The cursor never contains a username.** It's an opaque encoding of the last row's **id** only, and the server looks that row up again, under the tenant's RLS, to find where the next page starts. | Cursors go into page URLs, and a username is a matric or staff number: personal data. |
| P5 | **A cursor that doesn't resolve is a 400 `request.invalid_cursor`:** garbage, a deleted row, or another institution's user id, with the same answer for each. | RLS keeps a cursor within its institution, so it needs no signature, and the identical answer means a cursor can't probe whether an id exists elsewhere. |
| P6 | **The contract gains query parameters.** An operation declares a strict `query` object; the OpenAPI generator documents each property as a query parameter (and 400 `request.invalid`); the handler validates it with `parse(Ops.x.query, query)`; the client is regenerated. | So every later list endpoint gets cursor and filter parameters the same checked way. |
| P7 | **The Users page:** "Next page" and "Back to the first page", with the cursor in the page's own URL. A stale or edited link says so and leads back to the first page. | Simple and accessible. Going backwards by keyset adds complexity for little value. |
| P8 | **Compatibility:** `page` is added to the response; the query parameters are optional. With none, the answer is the same first page as before. | Additive for clients. |

## Implementation notes

- **Contracts** (`packages/contracts/src/api/pagination.ts`):
  - `PageQuery`, with `Cursor` (base64url, at most 200 characters) and `PageLimit`. `PageLimit`'s pattern admits exactly 1–200, so the published contract says what the server accepts.
  - `Page` and `paged(row)`.
  - `ApiOperation.query` is a strict zod object.
  - `listUsers` declares `query: PageQuery` and `400 request.invalid_cursor`, and the code has its user message.
- **The cursor** (`apps/api/src/shared/http/cursor.ts`) is base64url JSON `{ v: 1, id }`, decoded strictly. Another version, a non-UUID or an extra field decodes to nothing.
- **The handler** (`users.controller.ts`):
  - parses the query;
  - resolves the cursor's row through `forTenant` (so RLS applies), and an unresolved cursor is the 400;
  - reads `limit + 1` rows ordered `(username, id)` after that row, to know whether there's a next page.
- **The generator** (`openapi/document.ts`) documents each query property as an `in: query` parameter: its own schema converted for input, its description, and whether it's required. It adds `400 request.invalid` to any operation with a query.
- **The OpenAPI tests (OA3) now hold queries as they hold bodies:**
  - each documented query parameter is its operation's own field;
  - an operation with a query parses it in its handler;
  - the query object refuses an unknown parameter;
  - every controller parses only its own operation's `body` or `query`.
- **The web page** (`apps/web/.../workspace/users/page.tsx`) reads `?cursor=`, shows the pager (`.pager` in `shell.css`), and handles a 400 with the message for `request.invalid_cursor`.

**Tests:**

- **Unit (22):**
  - the cursor round-trip, and five kinds of bad cursor;
  - `PageQuery`'s limits (1, 50, 199 and 200 accepted; 0, 201, 999, 1000, -1, 01, 1.5, 1e2, " 5", abc and empty refused);
  - unknown and repeated parameters refused.
- **OpenAPI (OA3):** the query rules above.
- **Integration** (`users.int.spec.ts`, real database, 130 scratch users):
  - following the pages returns every user exactly once in order, with limits 1, 37, 50 and 200;
  - no parameters gives the first page plus `page`;
  - each bad query is a 400 with field errors;
  - the cursor carries only an id;
  - a garbage cursor, a deleted user's and **another institution's user's** get the same 400;
  - a user added before the cursor neither repeats nor shifts a row;
  - the permission check comes before any paging.
- **E2E** (`users.e2e.ts`, desktop and mobile):
  - next page and back, with no username in the URL and no serious accessibility violations;
  - a stale link's message and the way back.
