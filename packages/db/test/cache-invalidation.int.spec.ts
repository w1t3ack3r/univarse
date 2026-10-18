/**
 * Spec 0016 (ADR-031): the platform invalidation capture, at the database. Real Postgres, three roles:
 * the migrator (owner of the tables and functions), the platform app role (the API's) and the relay role.
 * The relay's own behaviour (IO7–IO11, IO18) is in apps/api/src/shared/infra/platform-invalidation-relay.int.spec.ts.
 *
 * Everything this suite writes is its own: a shard and tenants with random ids, settled (PUBLISHED, as the owner)
 * in afterAll so no pending event is left behind. Statements that could destroy data if a guard were missing
 * (TRUNCATE, DDL mutations) run inside transactions that are always rolled back. Two tests briefly shorten the
 * database's maximum TTL and restore it in `finally`; the IO15 gate also checks the value, so a run that dies
 * mid-way is caught by `pnpm rls:check`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureGateProblems } from '../scripts/capture-gate.js';
import { loadRootEnv, relayUrl, requireEnv } from '../scripts/env.js';

loadRootEnv();
const TENANTS = 'uv:tenants:invalidate';
const PRODUCTS = 'uv:products:invalidate';

let mig: pg.Client; // univarse_migrator
let app: pg.Client; // univarse_app_platform
let relay: pg.Client; // univarse_relay_platform
let shardId: string;
const created = new Set<string>();

interface Ev {
  channel: string;
  tenantId: string;
  source: string;
}

const connect = async (url: string) => {
  const c = new pg.Client({ connectionString: url, options: '-c TimeZone=UTC' });
  await c.connect();
  return c;
};

/** A tenant with one domain and one product row, written by `c` (committed unless `c` is inside a transaction). */
async function newTenant(c: pg.ClientBase, id: string = randomUUID()): Promise<string> {
  const slug = `io-${randomBytes(6).toString('hex')}`;
  await c.query(
    `INSERT INTO public.tenant (id, slug, legal_name, short_name, type, ownership, shard_id, updated_at)
     VALUES ($1, $2, 'Invalidation Test University', 'ITU', 'UNIVERSITY', 'FEDERAL', $3, now())`,
    [id, slug, shardId],
  );
  await c.query(
    `INSERT INTO public.tenant_domain (tenant_id, hostname, kind) VALUES ($1, $2, 'SUBDOMAIN')`,
    [id, `${slug}.io.test`],
  );
  await c.query(
    `INSERT INTO public.tenant_product (tenant_id, product, updated_at) VALUES ($1, 'core', now())`,
    [id],
  );
  created.add(id);
  return id;
}

/** The events naming these tenants, as `c` sees them (sorted: the order within a transaction doesn't matter). */
async function events(c: pg.ClientBase, ...tenantIds: string[]): Promise<Ev[]> {
  const r = await c.query<Ev>(
    `SELECT channel, tenant_id::text AS "tenantId", source FROM public.cache_invalidation_event
     WHERE tenant_id = ANY($1::uuid[])`,
    [tenantIds],
  );
  return sortEv(r.rows);
}
const sortEv = (rows: Ev[]) =>
  [...rows].sort((a, b) =>
    `${a.tenantId}${a.source}${a.channel}`.localeCompare(`${b.tenantId}${b.source}${b.channel}`),
  );
const ev = (channel: string, tenantId: string, source: string): Ev => ({
  channel,
  tenantId,
  source,
});
const created3 = (t: string) => [
  ev(TENANTS, t, 'tenant:INSERT'),
  ev(TENANTS, t, 'tenant_domain:INSERT'),
  ev(PRODUCTS, t, 'tenant_product:INSERT'),
];

/** Runs `fn` in a transaction that commits, or rolls back if `fn` throws (so a failure can't poison later tests). */
async function committed(c: pg.ClientBase, fn: () => Promise<void>): Promise<void> {
  await c.query('BEGIN');
  try {
    await fn();
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
  await c.query('COMMIT');
}

/** Runs `fn` in a transaction that is always rolled back. */
async function rolledBack<T>(c: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    return await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}

/** The SQLSTATE a statement fails with, or 'ok'. Inside a transaction it uses a savepoint, so the caller continues. */
async function sqlState(
  c: pg.ClientBase,
  sql: string,
  params: unknown[] = [],
  inTx = false,
): Promise<string> {
  if (inTx) await c.query('SAVEPOINT probe');
  try {
    await c.query(sql, params);
    if (inTx) await c.query('RELEASE SAVEPOINT probe');
    return 'ok';
  } catch (err) {
    if (inTx) await c.query('ROLLBACK TO SAVEPOINT probe');
    return (err as { code?: string }).code ?? 'unknown';
  }
}

async function setMaxTtl(ms: number): Promise<void> {
  await mig.query(`CREATE OR REPLACE FUNCTION public.cache_invalidation_max_ttl() RETURNS interval
    LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
    AS $$ SELECT interval '${String(ms)} milliseconds' $$`);
}

beforeAll(async () => {
  mig = await connect(requireEnv('PLATFORM_MIGRATOR_URL'));
  app = await connect(requireEnv('PLATFORM_DATABASE_URL'));
  relay = await connect(relayUrl());
  const s = await mig.query<{ id: string }>(
    `INSERT INTO public.shard (name, kind, secret_ref, region) VALUES ($1, 'POOL', 'IO_TEST_DATABASE_URL', 'local') RETURNING id`,
    [`io-test-${randomBytes(4).toString('hex')}`],
  );
  shardId = s.rows[0]!.id;
});

afterAll(async () => {
  await mig.query(`DELETE FROM public.tenant WHERE id = ANY($1::uuid[])`, [[...created]]);
  await mig.query(`DELETE FROM public.shard WHERE id = $1`, [shardId]);
  // Settle what this suite wrote, as the owner, so no relay inherits it.
  await mig.query(
    `UPDATE public.cache_invalidation_event SET status = 'PUBLISHED' WHERE status = 'PENDING' AND tenant_id = ANY($1::uuid[])`,
    [[...created]],
  );
  await Promise.all([mig.end(), app.end(), relay.end()]);
});

describe('[IO1][IO2] capture is transactional', () => {
  it('[IO1] each table writes its channel inside the writing transaction, invisible elsewhere until commit', async () => {
    const t = randomUUID();
    const expected = sortEv([
      ...created3(t),
      ev(PRODUCTS, t, 'tenant_product:UPDATE'),
      ev(TENANTS, t, 'tenant_domain:DELETE'),
    ]);
    await committed(mig, async () => {
      await newTenant(mig, t);
      await mig.query(`UPDATE public.tenant_product SET entitled = true WHERE tenant_id = $1`, [t]);
      await mig.query(`DELETE FROM public.tenant_domain WHERE tenant_id = $1`, [t]);
      expect(await events(mig, t)).toEqual(expected);
      expect(await events(relay, t)).toEqual([]);
    });
    expect(await events(relay, t)).toEqual(expected);
  });

  it('[IO1] the app role is captured too, with no privilege on the event table (SECURITY DEFINER capture)', async () => {
    const t = await newTenant(app);
    expect(await events(relay, t)).toEqual(sortEv(created3(t)));
  });

  it('[IO2] a rolled-back transaction leaves no event', async () => {
    const t = randomUUID();
    await rolledBack(mig, async () => {
      await newTenant(mig, t);
      expect(await events(mig, t)).toHaveLength(3);
    });
    expect(await events(relay, t)).toEqual([]);
  });

  it('[IO2] a rolled-back savepoint inside a committed transaction leaves no event for its change', async () => {
    const t = await newTenant(mig);
    await committed(mig, async () => {
      await mig.query(`UPDATE public.tenant SET short_name = 'KEPT' WHERE id = $1`, [t]);
      await mig.query('SAVEPOINT s');
      await mig.query(`UPDATE public.tenant_product SET entitled = true WHERE tenant_id = $1`, [t]);
      await mig.query('ROLLBACK TO SAVEPOINT s');
    });
    expect(await events(relay, t)).toEqual(
      sortEv([...created3(t), ev(TENANTS, t, 'tenant:UPDATE')]),
    );
  });
});

describe('[IO4][IO5] ownership changes and cascades', () => {
  it('[IO4] tenant_product and tenant_domain moving A → B name both tenants', async () => {
    const a = await newTenant(mig);
    const b = await newTenant(mig);
    await mig.query(
      `UPDATE public.tenant_product SET tenant_id = $2, product = 'bursary' WHERE tenant_id = $1`,
      [a, b],
    );
    await mig.query(`UPDATE public.tenant_domain SET tenant_id = $2 WHERE tenant_id = $1`, [a, b]);
    const moves = (await events(relay, a, b)).filter((e) => e.source.endsWith(':UPDATE'));
    expect(moves).toEqual(
      sortEv([
        ev(PRODUCTS, a, 'tenant_product:UPDATE'),
        ev(PRODUCTS, b, 'tenant_product:UPDATE'),
        ev(TENANTS, a, 'tenant_domain:UPDATE'),
        ev(TENANTS, b, 'tenant_domain:UPDATE'),
      ]),
    );
  });

  it('[IO4] tenant.id changing names the old and new id, for the tenant and the child rows ON UPDATE CASCADE moves', async () => {
    const a = await newTenant(mig);
    const b = randomUUID();
    created.add(b);
    await mig.query(`UPDATE public.tenant SET id = $2 WHERE id = $1`, [a, b]);
    const moves = (await events(relay, a, b)).filter((e) => e.source.endsWith(':UPDATE'));
    expect(moves).toEqual(
      sortEv([
        ev(TENANTS, a, 'tenant:UPDATE'),
        ev(TENANTS, b, 'tenant:UPDATE'),
        ev(TENANTS, a, 'tenant_domain:UPDATE'),
        ev(TENANTS, b, 'tenant_domain:UPDATE'),
        ev(PRODUCTS, a, 'tenant_product:UPDATE'),
        ev(PRODUCTS, b, 'tenant_product:UPDATE'),
      ]),
    );
  });

  it('[IO4] an UPDATE that keeps the tenant names it once; an UPDATE that changes nothing emits nothing', async () => {
    const t = await newTenant(mig);
    await mig.query(`UPDATE public.tenant_product SET entitled = true WHERE tenant_id = $1`, [t]);
    await mig.query(`UPDATE public.tenant_product SET entitled = entitled WHERE tenant_id = $1`, [
      t,
    ]);
    await mig.query(`UPDATE public.tenant SET slug = slug WHERE id = $1`, [t]);
    const updates = (await events(relay, t)).filter((e) => e.source.endsWith(':UPDATE'));
    expect(updates).toEqual([ev(PRODUCTS, t, 'tenant_product:UPDATE')]);
  });

  it('[IO5] deleting a tenant captures it and every row its cascade deletes', async () => {
    const t = await newTenant(mig);
    await mig.query(
      `INSERT INTO public.tenant_product (tenant_id, product, updated_at) VALUES ($1, 'bursary', now())`,
      [t],
    );
    await mig.query(`DELETE FROM public.tenant WHERE id = $1`, [t]);
    const deletes = (await events(relay, t)).filter((e) => e.source.endsWith(':DELETE'));
    expect(deletes).toEqual(
      sortEv([
        ev(TENANTS, t, 'tenant:DELETE'),
        ev(TENANTS, t, 'tenant_domain:DELETE'),
        ev(PRODUCTS, t, 'tenant_product:DELETE'),
        ev(PRODUCTS, t, 'tenant_product:DELETE'),
      ]),
    );
  });
});

describe('[IO6] TRUNCATE is refused (D1)', () => {
  const tables = ['tenant', 'tenant_domain', 'tenant_product', 'cache_invalidation_event'];

  it('[IO6] for the app and relay roles, on each guarded table and the event table, and no row is removed', async () => {
    await newTenant(mig);
    for (const c of [app, relay])
      for (const table of tables)
        expect([
          table,
          await rolledBack(c, () => sqlState(c, `TRUNCATE public.${table}`, [], true)),
        ]).toEqual([table, '42501']);
  });

  it('[IO6] for the migrator, the owner, by the trigger itself, and no row is removed', async () => {
    await newTenant(mig);
    for (const table of tables) {
      const outcome = await rolledBack(mig, async () => {
        const before = await mig.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public.${table}`,
        );
        // tenant is referenced by foreign keys, whose check would refuse first; drop them in this (rolled-back)
        // transaction so the refusal is provably the table's own trigger.
        if (table === 'tenant') {
          const fks = await mig.query<{ rel: string; name: string }>(
            `SELECT conrelid::regclass::text AS rel, conname AS name FROM pg_constraint WHERE confrelid = 'public.tenant'::regclass`,
          );
          for (const fk of fks.rows)
            await mig.query(`ALTER TABLE ${fk.rel} DROP CONSTRAINT ${fk.name}`);
        }
        let message = 'no error';
        await mig.query('SAVEPOINT t');
        try {
          await mig.query(`TRUNCATE ONLY public.${table}`);
        } catch (err) {
          message = `${(err as { code?: string }).code ?? ''} ${(err as Error).message}`;
        }
        await mig.query('ROLLBACK TO SAVEPOINT t');
        const after = await mig.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public.${table}`,
        );
        return {
          message,
          kept: after.rows[0]!.n === before.rows[0]!.n && before.rows[0]!.n !== '0',
        };
      });
      expect([table, outcome.kept, outcome.message]).toEqual([
        table,
        true,
        expect.stringMatching(/^42501 TRUNCATE on \w+ is refused/),
      ]);
    }
  });
});

describe('[IO14] the events hold no row values', () => {
  it('[IO14] the event table has exactly a channel, a tenant id, a source label and bookkeeping', async () => {
    const r = await mig.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cache_invalidation_event' ORDER BY column_name`,
    );
    expect(r.rows.map((x) => x.column_name)).toEqual([
      'attempts',
      'channel',
      'created_at',
      'first_observed_at',
      'id',
      'last_error',
      'next_attempt_at',
      'settled_at',
      'source',
      'status',
      'tenant_id',
    ]);
    const t = await newTenant(mig);
    for (const e of await events(relay, t))
      expect(e.source).toMatch(/^(tenant|tenant_domain|tenant_product):(INSERT|UPDATE|DELETE)$/);
  });
});

describe('[IO15] the gate in pnpm rls:check', () => {
  const gate = () => captureGateProblems(mig);
  const mutated = async (ddl: string) =>
    rolledBack(mig, async () => (await mig.query(ddl), gate()));

  it('[IO15] passes on the migrated database', async () => {
    expect(await gate()).toEqual([]);
  });

  it('[IO15] fails when a trigger is disabled, merely ENABLE (not ALWAYS), or dropped', async () => {
    expect(
      await mutated(`ALTER TABLE public.tenant DISABLE TRIGGER tenant_capture_cache_invalidation`),
    ).toEqual([
      "trigger tenant_capture_cache_invalidation on tenant is not ENABLE ALWAYS (tgenabled = 'D')",
    ]);
    expect(
      await mutated(
        `ALTER TABLE public.tenant_product ENABLE TRIGGER tenant_product_capture_cache_invalidation`,
      ),
    ).toEqual([
      "trigger tenant_product_capture_cache_invalidation on tenant_product is not ENABLE ALWAYS (tgenabled = 'O')",
    ]);
    expect(
      await mutated(
        `DROP TRIGGER cache_invalidation_event_guard_delete ON public.cache_invalidation_event`,
      ),
    ).toEqual([
      'trigger cache_invalidation_event_guard_delete on cache_invalidation_event is missing',
    ]);
  });

  it('[IO15] fails on EXECUTE for PUBLIC, a changed search_path, or TEMPORARY for the app or relay role', async () => {
    expect(
      await mutated(`GRANT EXECUTE ON FUNCTION public.capture_cache_invalidation() TO PUBLIC`),
    ).toEqual(['function capture_cache_invalidation is executable by PUBLIC']);
    expect(
      await mutated(
        `ALTER FUNCTION public.purge_settled_invalidation_events(integer) SET search_path = public, pg_temp`,
      ),
    ).toEqual([
      'function purge_settled_invalidation_events has search_path=public, pg_temp, expected search_path=pg_catalog, pg_temp',
    ]);
    expect(
      await mutated(`GRANT TEMPORARY ON DATABASE ${mig.database!} TO univarse_app_platform`),
    ).toEqual(['role univarse_app_platform may create TEMPORARY tables on the platform database']);
    expect(
      await mutated(`GRANT TEMPORARY ON DATABASE ${mig.database!} TO univarse_relay_platform`),
    ).toEqual([
      'role univarse_relay_platform may create TEMPORARY tables on the platform database',
    ]);
  });

  it('[IO15] fails when the database maximum TTL no longer equals MAX_TENANT_CACHE_TTL_MS', async () => {
    expect(
      await mutated(`CREATE OR REPLACE FUNCTION public.cache_invalidation_max_ttl() RETURNS interval
        LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT interval '1 millisecond' $$`),
    ).toEqual(['cache_invalidation_max_ttl() is 1 ms, expected 60000 (MAX_TENANT_CACHE_TTL_MS)']);
  });
});

describe('[IO16] the SECURITY DEFINER capture cannot be redirected by name lookup', () => {
  it('[IO16] with same-named tables in pg_temp and in a schema first on the search_path, the event lands in public', async () => {
    const t = await newTenant(mig);
    const shadow = `io_shadow_${randomBytes(4).toString('hex')}`;
    const landed = await rolledBack(mig, async () => {
      await mig.query(`CREATE SCHEMA ${shadow}`);
      await mig.query(
        `CREATE TABLE ${shadow}.cache_invalidation_event (LIKE public.cache_invalidation_event INCLUDING DEFAULTS)`,
      );
      await mig.query(
        `CREATE TEMP TABLE cache_invalidation_event (LIKE public.cache_invalidation_event INCLUDING DEFAULTS)`,
      );
      for (const path of [`pg_temp, ${shadow}, public`, `${shadow}, pg_temp, public`]) {
        await mig.query(`SELECT set_config('search_path', $1, true)`, [path]);
        await mig.query(
          `UPDATE public.tenant_product SET entitled = NOT entitled WHERE tenant_id = $1`,
          [t],
        );
      }
      const temp = await mig.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_temp.cache_invalidation_event`,
      );
      const schema = await mig.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${shadow}.cache_invalidation_event`,
      );
      const real = (await events(mig, t)).filter((e) => e.source === 'tenant_product:UPDATE');
      return { temp: temp.rows[0]!.n, schema: schema.rows[0]!.n, real: real.length };
    });
    expect(landed).toEqual({ temp: '0', schema: '0', real: 2 });
  });
});

describe('[IO17] privileges on the event table', () => {
  let pendingId: string;
  let tenant: string;
  beforeAll(async () => {
    tenant = await newTenant(mig);
    const r = await mig.query<{ id: string }>(
      `SELECT id FROM public.cache_invalidation_event WHERE tenant_id = $1 ORDER BY id LIMIT 1`,
      [tenant],
    );
    pendingId = r.rows[0]!.id;
  });

  it('[IO17] the app role is refused SELECT, INSERT, UPDATE, DELETE and TRUNCATE, one statement each', async () => {
    // Each statement needs only the privilege it tests (a WHERE would also need SELECT, and be refused for that).
    // Rolled back: if a privilege were granted, nothing would stay changed.
    const statements = [
      `SELECT 1 FROM public.cache_invalidation_event LIMIT 1`,
      `INSERT INTO public.cache_invalidation_event (channel, tenant_id, source) VALUES ('${TENANTS}', '${tenant}', 'x:INSERT')`,
      `UPDATE public.cache_invalidation_event SET last_error = NULL`,
      `DELETE FROM public.cache_invalidation_event`,
      `TRUNCATE public.cache_invalidation_event`,
    ];
    for (const sql of statements)
      expect([sql, await rolledBack(app, () => sqlState(app, sql, [], true))]).toEqual([
        sql,
        '42501',
      ]);
    const any = await mig.query<{ any: boolean }>(
      `SELECT has_any_column_privilege('univarse_app_platform', 'public.cache_invalidation_event', 'SELECT, INSERT, UPDATE, REFERENCES')
           OR has_table_privilege('univarse_app_platform', 'public.cache_invalidation_event', 'DELETE, TRUNCATE, TRIGGER, MAINTAIN') AS any`,
    );
    expect(any.rows[0]!.any).toBe(false);
  });

  it('[IO17] the relay role is refused INSERT, DELETE, TRUNCATE, any other column, and every other table', async () => {
    const statements = [
      `INSERT INTO public.cache_invalidation_event (channel, tenant_id, source) VALUES ('${TENANTS}', '${tenant}', 'x:INSERT')`,
      `DELETE FROM public.cache_invalidation_event`,
      `TRUNCATE public.cache_invalidation_event`,
      `UPDATE public.cache_invalidation_event SET tenant_id = gen_random_uuid() WHERE id = '${pendingId}'`,
      `UPDATE public.cache_invalidation_event SET first_observed_at = now() WHERE id = '${pendingId}'`,
      `UPDATE public.cache_invalidation_event SET settled_at = now() WHERE id = '${pendingId}'`,
      `SELECT 1 FROM public.tenant LIMIT 1`,
      `UPDATE public.tenant_product SET entitled = true WHERE tenant_id = '${tenant}'`,
    ];
    for (const sql of statements)
      expect([sql, await rolledBack(relay, () => sqlState(relay, sql, [], true))]).toEqual([
        sql,
        '42501',
      ]);
    const others = await mig.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND c.relname <> 'cache_invalidation_event'
         AND (has_any_column_privilege('univarse_relay_platform', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
              OR has_table_privilege('univarse_relay_platform', c.oid, 'DELETE, TRUNCATE, TRIGGER, MAINTAIN'))`,
    );
    expect(others.rows).toEqual([]);
  });

  it('[IO17] the relay role can claim (FOR UPDATE SKIP LOCKED and the stamping touch) and settle PUBLISHED; the database stamps both times', async () => {
    const t = await newTenant(mig);
    const out = await rolledBack(relay, async () => {
      const claimed = await relay.query<{ id: string }>(
        `SELECT id FROM public.cache_invalidation_event WHERE status = 'PENDING' AND tenant_id = $1
         ORDER BY next_attempt_at, id FOR UPDATE SKIP LOCKED`,
        [t],
      );
      const ids = claimed.rows.map((r) => r.id);
      const marker = (await relay.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0]!
        .at;
      await relay.query(
        `UPDATE public.cache_invalidation_event SET attempts = attempts WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      await relay.query(
        `UPDATE public.cache_invalidation_event SET status = 'PUBLISHED' WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      const r = await relay.query<{ observed: Date; settled: Date; status: string }>(
        `SELECT first_observed_at AS observed, settled_at AS settled, status FROM public.cache_invalidation_event WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return { n: ids.length, marker, rows: r.rows };
    });
    expect(out.n).toBe(3);
    for (const r of out.rows) {
      expect(r.status).toBe('PUBLISHED');
      expect(r.observed.getTime()).toBeGreaterThanOrEqual(out.marker.getTime());
      expect(r.settled.getTime()).toBeGreaterThanOrEqual(r.observed.getTime());
    }
  });

  it('[IO17][IO12] EXPIRED is refused before first observation + max + 5 s, even for the relay, and allowed after it', async () => {
    const t = await newTenant(mig);
    const [{ id }] = (
      await relay.query<{ id: string }>(
        `SELECT id FROM public.cache_invalidation_event WHERE tenant_id = $1 LIMIT 1`,
        [t],
      )
    ).rows as [{ id: string }];
    // Refused at the real maximum: first observation is now.
    await relay.query(
      `UPDATE public.cache_invalidation_event SET attempts = attempts WHERE id = $1`,
      [id],
    );
    expect(
      await sqlState(
        relay,
        `UPDATE public.cache_invalidation_event SET status = 'EXPIRED' WHERE id = $1`,
        [id],
      ),
    ).toBe('23514');
    // With the maximum shortened to zero, the bound is first observation + 5 s.
    await setMaxTtl(0);
    try {
      expect(
        await sqlState(
          relay,
          `UPDATE public.cache_invalidation_event SET status = 'EXPIRED' WHERE id = $1`,
          [id],
        ),
      ).toBe('23514');
      await sleep(5_300);
      expect(
        await sqlState(
          relay,
          `UPDATE public.cache_invalidation_event SET status = 'EXPIRED' WHERE id = $1`,
          [id],
        ),
      ).toBe('ok');
    } finally {
      await setMaxTtl(60_000);
    }
    const r = await mig.query<{ status: string; settled: boolean }>(
      `SELECT status, settled_at IS NOT NULL AS settled FROM public.cache_invalidation_event WHERE id = $1`,
      [id],
    );
    expect(r.rows[0]).toEqual({ status: 'EXPIRED', settled: true });
  }, 15_000);

  it('[IO17][IO18] the relay purge deletes events settled over 24 h ago, and keeps pending and recently settled ones', async () => {
    // Fixtures written directly by the owner (INSERT is not guarded; only the owner may do it).
    const t = randomUUID();
    created.add(t);
    const insert = async (status: string, settledAgo: string | null) =>
      (
        await mig.query<{ id: string }>(
          `INSERT INTO public.cache_invalidation_event (channel, tenant_id, source, status, settled_at)
           VALUES ($1, $2, 'tenant:UPDATE', $3, CASE WHEN $4::interval IS NULL THEN NULL ELSE clock_timestamp() - $4::interval END)
           RETURNING id`,
          [TENANTS, t, status, settledAgo],
        )
      ).rows[0]!.id;
    await insert('PUBLISHED', '25 hours'); // purged
    const recent = await insert('PUBLISHED', '23 hours');
    const pending = await insert('PENDING', null);
    const purged = await relay.query<{ n: number }>(
      `SELECT public.purge_settled_invalidation_events(10000) AS n`,
    );
    expect(purged.rows[0]!.n).toBeGreaterThanOrEqual(1);
    const left = await mig.query<{ id: string }>(
      `SELECT id FROM public.cache_invalidation_event WHERE tenant_id = $1`,
      [t],
    );
    expect(left.rows.map((r) => r.id).sort()).toEqual([recent, pending].sort());
    expect(await sqlState(relay, `SELECT public.purge_settled_invalidation_events(0)`)).toBe(
      '22023',
    );
  });
});

describe('[IO17] the guard triggers hold for every role, the owner included', () => {
  it('[IO17] a settled event cannot change; identity cannot change; status moves only PENDING → PUBLISHED or EXPIRED', async () => {
    const t = await newTenant(mig);
    const ids = (
      await mig.query<{ id: string }>(
        `SELECT id FROM public.cache_invalidation_event WHERE tenant_id = $1 ORDER BY id`,
        [t],
      )
    ).rows.map((r) => r.id);
    const [a, b] = ids as [string, string];
    expect(
      await sqlState(
        mig,
        `UPDATE public.cache_invalidation_event SET tenant_id = gen_random_uuid() WHERE id = $1`,
        [a],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        mig,
        `UPDATE public.cache_invalidation_event SET source = 'other:UPDATE' WHERE id = $1`,
        [a],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        mig,
        `UPDATE public.cache_invalidation_event SET status = 'PUBLISHED' WHERE id = $1`,
        [a],
      ),
    ).toBe('ok');
    expect(
      await sqlState(
        mig,
        `UPDATE public.cache_invalidation_event SET status = 'PENDING' WHERE id = $1`,
        [a],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        mig,
        `UPDATE public.cache_invalidation_event SET last_error = 'X' WHERE id = $1`,
        [a],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        mig,
        `UPDATE public.cache_invalidation_event SET status = 'EXPIRED' WHERE id = $1`,
        [b],
      ),
    ).toBe('23514');
  });

  it('[IO17][IO12] first_observed_at and settled_at are the database clock: supplied values are ignored, and never move', async () => {
    const t = await newTenant(mig);
    const id = (
      await mig.query<{ id: string }>(
        `SELECT id FROM public.cache_invalidation_event WHERE tenant_id = $1 LIMIT 1`,
        [t],
      )
    ).rows[0]!.id;
    const marker = (await mig.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0]!.at;
    await mig.query(
      `UPDATE public.cache_invalidation_event SET first_observed_at = '2000-01-01', settled_at = '2000-01-01' WHERE id = $1`,
      [id],
    );
    const first = (
      await mig.query<{ o: Date; s: Date | null }>(
        `SELECT first_observed_at AS o, settled_at AS s FROM public.cache_invalidation_event WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(first.o.getTime()).toBeGreaterThanOrEqual(marker.getTime());
    expect(first.s).toBeNull();
    await mig.query(
      `UPDATE public.cache_invalidation_event SET first_observed_at = clock_timestamp() + interval '1 day', attempts = 1 WHERE id = $1`,
      [id],
    );
    const second = (
      await mig.query<{ o: Date }>(
        `SELECT first_observed_at AS o FROM public.cache_invalidation_event WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
    expect(second.o.getTime()).toBe(first.o.getTime());
  });

  it('[IO17] a row can be deleted only once settled for 24 h', async () => {
    const t = randomUUID();
    created.add(t);
    const insert = async (status: string, settledAgo: string | null) =>
      (
        await mig.query<{ id: string }>(
          `INSERT INTO public.cache_invalidation_event (channel, tenant_id, source, status, settled_at)
           VALUES ($1, $2, 'tenant:UPDATE', $3, CASE WHEN $4::interval IS NULL THEN NULL ELSE clock_timestamp() - $4::interval END)
           RETURNING id`,
          [TENANTS, t, status, settledAgo],
        )
      ).rows[0]!.id;
    const pending = await insert('PENDING', null);
    const recent = await insert('PUBLISHED', '23 hours');
    const old = await insert('EXPIRED', '25 hours');
    const del = (id: string) =>
      sqlState(mig, `DELETE FROM public.cache_invalidation_event WHERE id = $1`, [id]);
    expect([await del(pending), await del(recent), await del(old)]).toEqual([
      '23514',
      '23514',
      'ok',
    ]);
  });
});
