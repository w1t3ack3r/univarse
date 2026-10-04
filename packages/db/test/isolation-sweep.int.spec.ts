/**
 * Spec 0004 — generic tenant-isolation sweep (docs/12 §3, layer 2).
 * Tables are discovered from pg_catalog; every one must have a fixture (I1). Each check runs as the
 * APP role (univarse_app, NOBYPASSRLS) in its own rolled-back transaction. Any failure is a release blocker.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRootEnv, requireEnv } from '../scripts/env.js';
import { createTenantShardClient, withTenantTx, type TenantShardClient, type TenantTx } from '../src/tenant.js';

loadRootEnv();
const url = requireEnv('TENANT_POOL_01_DATABASE_URL');
const A = randomUUID();
const B = randomUUID();
const RLS_VIOLATION = /violates row-level security policy/;
const PERMISSION_DENIED = /permission denied/;

/** Same rule as the static checker (scripts/rls-check.ts): every public table with tenant_id. */
async function discoverTenantTables(client: pg.Client): Promise<string[]> {
  const res = await client.query<{ table: string }>(`
    SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
    ORDER BY 1`);
  return res.rows.map((r) => r.table);
}

const bytes = (n = 32) => new Uint8Array(randomBytes(n));
const soon = () => new Date(Date.now() + 3_600_000);

/**
 * One row per tenant table, for one tenant, written under that tenant's context (I2).
 * A new tenant table must be added here, or I1 fails.
 */
async function buildFixtures(tx: TenantTx, tenantId: string): Promise<Record<string, string>> {
  const tag = randomBytes(4).toString('hex');
  const unit = await tx.orgUnit.create({ data: { tenantId, code: `SWEEP-${tag}`, name: 'Sweep Faculty', kind: 'ACADEMIC', type: 'FACULTY', path: '/' } });
  const user = await tx.userAccount.create({ data: { tenantId, username: `SWEEP/${tag}`, displayName: 'Sweep User' } });
  const role = await tx.role.create({ data: { tenantId, key: `SWEEP_${tag}`, name: 'Sweep Role' } });
  const userId = user.id;
  const rows: Record<string, string> = {
    org_unit: unit.id,
    user_account: userId,
    role: role.id,
    role_assignment: (await tx.roleAssignment.create({ data: { tenantId, userId, roleId: role.id, scopeType: 'INSTITUTION' } })).id,
    session: (await tx.session.create({ data: { tenantId, userId, tokenHash: bytes(), idleExpiresAt: soon(), absoluteExpiresAt: soon() } })).id,
    mfa_factor: (await tx.mfaFactor.create({ data: { tenantId, userId, type: 'TOTP', secretEnc: 'v1:sweep:not-a-secret' } })).id,
    mfa_challenge: (await tx.mfaChallenge.create({ data: { tenantId, userId, tokenHash: bytes(), expiresAt: soon() } })).id,
    recovery_code: (await tx.recoveryCode.create({ data: { tenantId, userId, codeHash: bytes() } })).id,
    one_time_token: (await tx.oneTimeToken.create({ data: { tenantId, userId, purpose: 'ACTIVATION', tokenHash: bytes(), channel: 'email', expiresAt: soon() } })).id,
    audit_event: (
      await tx.auditEvent.create({
        data: { tenantId, seq: 1n, actorType: 'SYSTEM', action: 'test.sweep', entityType: 'test', prevHash: bytes(), hash: bytes() },
      })
    ).id,
    outbox_event: (await tx.outboxEvent.create({ data: { tenantId, type: 'test.sweep', status: 'DEAD' } })).id,
    setting: (await tx.setting.create({ data: { tenantId, key: `sweep.${tag}`, value: { on: true } } })).id,
    file_object: (await tx.fileObject.create({ data: { tenantId, bucketKey: `sweep/${tag}`, originalName: 'x.pdf', mime: 'application/pdf', sizeBytes: 1n } })).id,
    sequence: (await tx.sequence.create({ data: { tenantId, name: `sweep.${tag}` } })).id,
  };
  return rows;
}

let raw: pg.Client;
let shard: TenantShardClient;
let tables: string[] = [];
const fixtures: Record<string, Record<string, string>> = {};

/** Runs one statement in its own transaction under `tenantId` (or none), always rolled back. */
async function as(tenantId: string | null, sql: string, params: unknown[] = []): Promise<pg.QueryResult> {
  await raw.query('BEGIN');
  try {
    if (tenantId) await raw.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await raw.query(sql, params);
  } finally {
    await raw.query('ROLLBACK');
  }
}
/** The error message, or null if the statement succeeded. */
async function errorOf(tenantId: string | null, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await as(tenantId, sql, params);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const count = async (tenantId: string | null, t: string, where = 'TRUE', params: unknown[] = []) =>
  Number((await as(tenantId, `SELECT count(*)::int AS n FROM ${q(t)} WHERE ${where}`, params)).rows[0].n);
/** Identifiers come from pg_catalog, but are still validated before interpolation. */
const q = (ident: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(ident)) throw new Error(`unexpected identifier ${ident}`);
  return `"${ident}"`;
};
const priv = async (t: string, p: 'UPDATE' | 'DELETE' | 'INSERT') =>
  (await raw.query<{ ok: boolean }>(`SELECT has_table_privilege(current_user, $1, $2) AS ok`, [`public.${t}`, p])).rows[0]!.ok;
/** A non-key column the app role may UPDATE, if any (I4). */
const updatableColumn = async (t: string) =>
  (
    await raw.query<{ col: string }>(
      `SELECT column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name NOT IN ('id', 'tenant_id')
         AND has_column_privilege(current_user, 'public.' || $1, column_name, 'UPDATE')
       ORDER BY ordinal_position LIMIT 1`,
      [t],
    )
  ).rows[0]?.col;
const canUpdateTenantId = async (t: string) =>
  (await raw.query<{ ok: boolean }>(`SELECT has_column_privilege(current_user, $1, 'tenant_id', 'UPDATE') AS ok`, [`public.${t}`])).rows[0]!.ok;
/** The A fixture row as JSON with id and tenant_id replaced, for a generic INSERT copy (I7/I8). */
async function copyOf(t: string, tenantForCopy: string): Promise<string> {
  const res = await as(A, `SELECT to_jsonb(x) AS j FROM ${q(t)} x WHERE x.id = $1`, [fixtures[A]![t]]);
  const row = res.rows[0].j as Record<string, unknown>;
  return JSON.stringify({ ...row, id: randomUUID(), tenant_id: tenantForCopy });
}
const insertCopy = (t: string) => `INSERT INTO ${q(t)} SELECT (jsonb_populate_record(NULL::${q(t)}, $1::jsonb)).*`;

beforeAll(async () => {
  raw = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await raw.connect();
  shard = createTenantShardClient(url);
  tables = await discoverTenantTables(raw);
  fixtures[A] = await withTenantTx(shard, A, (tx) => buildFixtures(tx, A));
  fixtures[B] = await withTenantTx(shard, B, (tx) => buildFixtures(tx, B));
});

afterAll(async () => {
  // Delete what the app role may delete (children first). Append-only rows of these random,
  // non-existent tenants remain; RLS hides them from every real tenant.
  const order = ['role_assignment', 'session', 'mfa_factor', 'mfa_challenge', 'recovery_code', 'one_time_token', 'setting', 'file_object', 'sequence', 'user_account', 'role', 'org_unit'];
  for (const tenant of [A, B]) {
    await raw.query('BEGIN');
    await raw.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
    for (const t of order) if (await priv(t, 'DELETE')) await raw.query(`DELETE FROM ${q(t)} WHERE id = $1`, [fixtures[tenant]?.[t]]);
    await raw.query('COMMIT');
  }
  await raw.end();
  await shard.$disconnect();
});

describe('tenant isolation sweep (spec 0004)', () => {
  it('[I9] runs as the app role, which can neither bypass RLS nor act as superuser', async () => {
    const r = await raw.query<{ who: string; bypass: boolean; superuser: boolean }>(
      `SELECT current_user AS who, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`,
    );
    expect(r.rows[0]).toEqual({ who: 'univarse_app', bypass: false, superuser: false });
  });

  it('[I1] every discovered tenant table has a fixture, and every fixture is a real table', () => {
    expect(tables.length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(fixtures[A]!).sort()).toEqual([...tables].sort());
  });

  it('[I2] each tenant sees its own fixture row in every table (the sweep is not vacuous)', async () => {
    for (const t of tables) {
      for (const tenant of [A, B]) {
        expect(await count(tenant, t, 'id = $1', [fixtures[tenant]![t]]), `${t} own row`).toBe(1);
      }
    }
  });

  it("[I3] reads: under A, none of B's rows are visible, filtered or not", async () => {
    for (const t of tables) {
      expect(await count(A, t, 'tenant_id = $1', [B]), `${t} filtered`).toBe(0);
      expect(await count(A, t, 'id = $1', [fixtures[B]![t]]), `${t} by id`).toBe(0);
      expect(await count(A, t, 'tenant_id <> $1', [A]), `${t} unfiltered`).toBe(0);
    }
  });

  it("[I4] updates: under A, an UPDATE aimed at B's rows changes nothing (or is refused by grants)", async () => {
    for (const t of tables) {
      const col = await updatableColumn(t);
      if (!col) {
        expect(await errorOf(A, `UPDATE ${q(t)} SET tenant_id = tenant_id WHERE tenant_id = $1`, [B]), `${t} append-only`).toMatch(PERMISSION_DENIED);
        continue;
      }
      const res = await as(A, `UPDATE ${q(t)} SET ${q(col)} = ${q(col)} WHERE tenant_id = $1 OR id = $2`, [B, fixtures[B]![t]]);
      expect(res.rowCount, `${t}.${col}`).toBe(0);
    }
  });

  it("[I5] moves: under A, re-pointing A's row to tenant B is refused (policy WITH CHECK, or grants)", async () => {
    for (const t of tables) {
      const err = await errorOf(A, `UPDATE ${q(t)} SET tenant_id = $1 WHERE id = $2`, [B, fixtures[A]![t]]);
      expect(err, t).toMatch((await canUpdateTenantId(t)) ? RLS_VIOLATION : PERMISSION_DENIED);
    }
  });

  it("[I6] deletes: under A, a DELETE aimed at B's rows removes nothing (or is refused by grants)", async () => {
    for (const t of tables) {
      if (!(await priv(t, 'DELETE'))) {
        expect(await errorOf(A, `DELETE FROM ${q(t)} WHERE tenant_id = $1`, [B]), `${t} append-only`).toMatch(PERMISSION_DENIED);
      } else {
        // Committed on purpose: if isolation failed, B's row would really be gone and the next assertion catches it.
        await raw.query('BEGIN');
        await raw.query(`SELECT set_config('app.tenant_id', $1, true)`, [A]);
        const res = await raw.query(`DELETE FROM ${q(t)} WHERE tenant_id = $1 OR id = $2`, [B, fixtures[B]![t]]);
        await raw.query('COMMIT');
        expect(res.rowCount, t).toBe(0);
      }
      expect(await count(B, t, 'id = $1', [fixtures[B]![t]]), `${t} B row still there`).toBe(1);
    }
  });

  it('[I7] inserts: under A, a row carrying tenant_id = B fails with the RLS violation', async () => {
    for (const t of tables) {
      expect(await priv(t, 'INSERT'), `${t} insertable`).toBe(true);
      expect(await errorOf(A, insertCopy(t), [await copyOf(t, B)]), t).toMatch(RLS_VIOLATION);
    }
  });

  it('[I8] no tenant context: nothing is visible and nothing can be inserted', async () => {
    for (const t of tables) {
      expect(await count(null, t), `${t} select`).toBe(0);
      expect(await errorOf(null, insertCopy(t), [await copyOf(t, A)]), `${t} insert`).toMatch(RLS_VIOLATION);
    }
  });
});
