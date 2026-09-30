/**
 * Tenant isolation — dynamic layer (docs/12-testing-strategy.md §3).
 * Runs as the APP role (univarse_app, NOBYPASSRLS) against the real pool shard.
 * Any failure here is a release blocker.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTenantShardClient, forTenant, withTenantTx, type TenantShardClient } from '../src/tenant.js';
import { loadRootEnv, requireEnv } from '../scripts/env.js';

loadRootEnv();
const url = requireEnv('TENANT_POOL_01_DATABASE_URL');

const A = randomUUID();
const B = randomUUID();
let shard: TenantShardClient;
let raw: pg.Client;
let userA: string;
let unitB: string;

async function asTenant<T>(tenantId: string | null, sql: string, params: unknown[] = []) {
  await raw.query('BEGIN');
  try {
    if (tenantId) await raw.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return (await raw.query(sql, params)) as pg.QueryResult & { rows: T[] };
  } finally {
    await raw.query('ROLLBACK');
  }
}

beforeAll(async () => {
  shard = createTenantShardClient(url);
  raw = new pg.Client({ connectionString: url });
  await raw.connect();

  const a = forTenant(shard, A);
  const b = forTenant(shard, B);
  userA = (await a.userAccount.create({ data: { tenantId: A, username: 'STAFF/001', displayName: 'Adaeze Okafor' } })).id;
  unitB = (
    await b.orgUnit.create({
      data: { tenantId: B, code: 'SCI', name: 'Faculty of Science', kind: 'ACADEMIC', type: 'FACULTY', path: '/' },
    })
  ).id;
  await b.userAccount.create({ data: { tenantId: B, username: 'STAFF/001', displayName: 'Bello Musa' } });
});

afterAll(async () => {
  await forTenant(shard, A).userAccount.deleteMany({});
  await forTenant(shard, B).userAccount.deleteMany({});
  await forTenant(shard, B).orgUnit.deleteMany({});
  await raw.end();
  await shard.$disconnect();
});

describe('tenant isolation (RLS, forced)', () => {
  it('each tenant sees only its own rows (same username in both tenants is allowed)', async () => {
    const seenByA = await forTenant(shard, A).userAccount.findMany();
    const seenByB = await forTenant(shard, B).userAccount.findMany();
    expect(seenByA.map((u) => u.displayName)).toEqual(['Adaeze Okafor']);
    expect(seenByB.map((u) => u.displayName)).toEqual(['Bello Musa']);
  });

  it('reading another tenant row by id returns nothing', async () => {
    expect(await forTenant(shard, B).userAccount.findUnique({ where: { id: userA } })).toBeNull();
    expect(await forTenant(shard, A).orgUnit.findFirst({ where: { id: unitB } })).toBeNull();
  });

  it('updating or deleting another tenant row affects 0 rows', async () => {
    const upd = await forTenant(shard, B).userAccount.updateMany({ where: { id: userA }, data: { displayName: 'pwned' } });
    const del = await forTenant(shard, B).userAccount.deleteMany({ where: { id: userA } });
    expect([upd.count, del.count]).toEqual([0, 0]);
    expect((await forTenant(shard, A).userAccount.findUnique({ where: { id: userA } }))?.displayName).toBe('Adaeze Okafor');
  });

  it('inserting a row for another tenant is rejected (WITH CHECK)', async () => {
    await expect(
      forTenant(shard, A).userAccount.create({ data: { tenantId: B, username: 'X', displayName: 'Intruder' } }),
    ).rejects.toThrow();
  });

  it('with no tenant context, reads return 0 rows and writes fail (fails closed)', async () => {
    const r = await asTenant(null, 'SELECT count(*)::int AS n FROM user_account');
    expect(r.rows[0]).toEqual({ n: 0 });
    await expect(
      asTenant(null, `INSERT INTO user_account (id, tenant_id, username, display_name, updated_at) VALUES (uuidv7(), $1, 'Y', 'Y', now())`, [A]),
    ).rejects.toThrow(/row-level security/);
  });

  it('a foreign key cannot point at another tenant row (composite FKs)', async () => {
    await expect(
      withTenantTx(shard, B, (tx) =>
        tx.session.create({
          data: {
            tenantId: B,
            userId: userA, // tenant A's user
            tokenHash: Buffer.alloc(32, 1),
            idleExpiresAt: new Date(Date.now() + 60_000),
            absoluteExpiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('audit_event is append-only for the app role', async () => {
    await withTenantTx(shard, A, (tx) =>
      tx.auditEvent.create({
        data: { tenantId: A, actorType: 'SYSTEM', action: 'test.isolation', entityType: 'test', prevHash: Buffer.alloc(32), hash: Buffer.alloc(32, 7) },
      }),
    );
    await expect(asTenant(A, `UPDATE audit_event SET action = 'tampered'`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(A, `DELETE FROM audit_event`)).rejects.toThrow(/permission denied/);
  });

  it('the app role cannot bypass RLS', async () => {
    const r = await raw.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});
