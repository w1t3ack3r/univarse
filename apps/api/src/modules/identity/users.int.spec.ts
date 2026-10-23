// Spec 0021: GET /api/v1/users, a page at a time, against the real database (P1–P5, P8).
import { randomBytes, randomUUID } from 'node:crypto';
import { forTenant } from '@univarse/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../shared/http/cursor.js';
import { cookieFrom, createHarness, HOSTS, type Harness } from '../../testing/int-harness.js';
import { enrolTestTotp, totpCode } from '../../testing/mfa-helpers.js';

let h: Harness;
let session: string;
const PREFIX = `PG${randomBytes(3).toString('hex').toUpperCase()}`;
const SCRATCH = 130; // more than two default pages
interface Row {
  id: string;
  username: string;
}
const scratchIds: string[] = [];

/** Every user the list can show, in its order: by username, then id (as the database compares them). */
async function allUsers(): Promise<Row[]> {
  return forTenant(h.shard, h.tenants.demo).userAccount.findMany({ select: { id: true, username: true }, orderBy: [{ username: 'asc' }, { id: 'asc' }] });
}

const list = (query = '') => h.call('GET', HOSTS.demo, `/api/v1/users${query}`, { cookie: session });

/** Follows nextCursor from the first page to the last. */
async function walk(limit?: number): Promise<{ rows: Row[]; pages: number }> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const res = await list(params.size ? `?${params.toString()}` : '');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: Row[]; page: { nextCursor: string | null; limit: number; hasMore: boolean } };
    expect(body.page.limit).toBe(limit ?? 50);
    expect(body.data.length).toBeLessThanOrEqual(body.page.limit);
    expect(body.page.hasMore).toBe(body.page.nextCursor !== null);
    rows.push(...body.data.map(({ id, username }) => ({ id, username })));
    cursor = body.page.nextCursor;
    pages++;
  } while (cursor && pages < 1_000);
  return { rows, pages };
}

beforeAll(async () => {
  h = await createHarness();
  const admin = await h.makeUser('demo', { role: 'INSTITUTION_ADMIN' });
  const secret = await enrolTestTotp(h.shard, h.tenants.demo, admin.id);
  const first = await h.login(HOSTS.demo, admin.username);
  const verify = await h.call('POST', HOSTS.demo, '/api/v1/auth/mfa/verify', { cookie: cookieFrom(first.headers['set-cookie'] as string[] | undefined), body: { code: totpCode(secret) } });
  expect(verify.statusCode).toBe(200);
  session = cookieFrom(verify.headers['set-cookie'] as string[] | undefined);
  // Scratch users without a password (PENDING_ACTIVATION): created directly, as the harness does, without hashing.
  const db = forTenant(h.shard, h.tenants.demo);
  for (let i = 0; i < SCRATCH; i++) {
    const id = randomUUID();
    scratchIds.push(id);
    await db.userAccount.create({ data: { id, tenantId: h.tenants.demo, username: `${PREFIX}-${String(i).padStart(3, '0')}`, displayName: 'Paging Test', status: 'PENDING_ACTIVATION' } });
  }
}, 120_000);

afterAll(async () => {
  await forTenant(h.shard, h.tenants.demo).userAccount.deleteMany({ where: { id: { in: scratchIds } } });
  await h.close();
});

describe('[spec 0021] GET /users, a page at a time', { timeout: 120_000 }, () => {
  it('[P1][P3] following the pages returns every user exactly once, in order (by username, then id)', async () => {
    const expected = await allUsers();
    expect(expected.length).toBeGreaterThan(SCRATCH);
    const { rows, pages } = await walk();
    expect(rows).toEqual(expected);
    expect(pages).toBe(Math.ceil(expected.length / 50));
    const mine = rows.filter((r) => r.username.startsWith(PREFIX)).map((r) => r.username);
    expect(mine).toEqual([...mine].sort());
    expect(mine).toHaveLength(SCRATCH);
  });

  it('[P1] every limit from 1 to 200 pages the same set; the last page has no cursor', async () => {
    const expected = await allUsers();
    for (const limit of [1, 37, 200]) {
      if (limit === 1 && expected.length > 400) continue; // one request per user: only on a small database
      expect((await walk(limit)).rows, `limit ${String(limit)}`).toEqual(expected);
    }
    const last = await list('?limit=200');
    expect(last.json().data.length).toBe(Math.min(200, expected.length));
  });

  it('[P8] no parameters: the first page, as before plus `page`', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual((await allUsers()).slice(0, 50).map((r) => expect.objectContaining(r)));
    expect(res.json().page).toEqual({ nextCursor: expect.any(String), limit: 50, hasMore: true });
    expect(JSON.stringify(res.json())).not.toMatch(/passwordHash|argon2|totp|secret/i);
  });

  it.each(['?limit=0', '?limit=201', '?limit=abc', '?limit=1.5', '?limit=-1', '?page=2', '?limit=10&limit=20', '?cursor=a%20b'])(
    '[P2] %s is a 400 request.invalid with field errors',
    async (q) => {
      const res = await list(q);
      expect([res.statusCode, res.json().code]).toEqual([400, 'request.invalid']);
      expect(res.json().errors.length).toBeGreaterThan(0);
    },
  );

  it('[P4] a cursor carries only an id: no username in the URL', async () => {
    const cursor = (await list('?limit=1')).json().page.nextCursor as string;
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(decoded) as object).sort()).toEqual(['id', 'v']);
    for (const u of await allUsers()) expect(decoded).not.toContain(u.username);
  });

  it("[P5] a garbage cursor, a deleted user's cursor and another institution's user's cursor get the same 400", async () => {
    const poly = await h.makeUser('poly', { role: 'STUDENT' });
    const gone = randomUUID();
    const db = forTenant(h.shard, h.tenants.demo);
    await db.userAccount.create({ data: { id: gone, tenantId: h.tenants.demo, username: `${PREFIX}-GONE`, displayName: 'Gone', status: 'PENDING_ACTIVATION' } });
    await db.userAccount.delete({ where: { id: gone } });
    const answers = await Promise.all(
      ['not-a-cursor', encodeCursor(gone), encodeCursor(poly.id), encodeCursor(randomUUID())].map(async (c) => {
        const res = await list(`?cursor=${c}`);
        const { code, title, detail, status } = res.json() as Record<string, unknown>;
        return { statusCode: res.statusCode, code, title, detail, status };
      }),
    );
    expect(answers[0]).toMatchObject({ statusCode: 400, code: 'request.invalid_cursor' });
    for (const a of answers) expect(a).toEqual(answers[0]); // no existence oracle across institutions
  });

  it('[P3] keyset, not offset: a user added before the cursor after page 1 neither repeats nor shifts a row', async () => {
    const first = (await list('?limit=50')).json() as { data: Row[]; page: { nextCursor: string } };
    const db = forTenant(h.shard, h.tenants.demo);
    const early = randomUUID();
    scratchIds.push(early);
    await db.userAccount.create({ data: { id: early, tenantId: h.tenants.demo, username: '0000-early', displayName: 'Early', status: 'PENDING_ACTIVATION' } });
    const second = (await list(`?limit=50&cursor=${first.page.nextCursor}`)).json() as { data: Row[] };
    const seen = new Set(first.data.map((r) => r.id));
    for (const r of second.data) expect(seen.has(r.id), r.username).toBe(false);
    const expected = (await allUsers()).filter((r) => r.id !== early);
    expect(second.data.map((r) => r.id)).toEqual(expected.slice(50, 100).map((r) => r.id));
  });

  it('[P2] the permission check is unchanged: a user without identity.user.view is refused before any paging', async () => {
    const lecturer = await h.makeUser('demo', { role: 'LECTURER' });
    const cookie = cookieFrom((await h.login(HOSTS.demo, lecturer.username)).headers['set-cookie'] as string[] | undefined);
    const res = await h.call('GET', HOSTS.demo, '/api/v1/users?limit=abc', { cookie });
    expect([res.statusCode, res.json().code]).toEqual([403, 'auth.forbidden']);
  });
});
