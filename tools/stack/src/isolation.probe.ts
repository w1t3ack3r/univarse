/**
 * Spec 0019 B6/LS5: spec 0017's PB1 and PB2 through the STACK's PgBouncer (the deployed path), at its own pool size,
 * with PB2's negative assertions kept. Run only by `pnpm stack:isolation`, which opens the tunnel and gives this the
 * settings from STACK_DIR (test-env.ts). Its fixtures are removed afterwards, exactly, as the superuser inside the
 * PostgreSQL container (the app role may not delete outbox rows, rightly).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatformClient } from '../../../packages/db/src/platform.js';
import { createTenantShardClient, forTenant, withTenantTx, type TenantShardClient } from '../../../packages/db/src/tenant.js';
import { tenantRowProblems } from '../../../packages/db/test/tenant-rows.js';
import { PROJECT } from './config.js';
import { docker } from './docker.js';
import { loadSecrets } from './secrets.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is missing: run pnpm stack:isolation (never the root .env)`);
  return v;
};
const BOUNCER_PLATFORM = need('PLATFORM_DATABASE_URL');
const BOUNCER_TENANT = need('TENANT_POOL_01_DATABASE_URL');
const ADMIN = need('PGBOUNCER_ADMIN_URL');
const UTC = '-c TimeZone=UTC';

/** The one row a query must return. */
function one<T>(rows: readonly T[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('expected a row');
  return r;
}
/** An element that must exist. */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element ${String(i)}`);
  return x;
}

const client = async (url: string, options?: string) => {
  const c = new pg.Client({ connectionString: url, ...(options ? { options } : {}) });
  c.on('error', () => {});
  await c.connect();
  return c;
};
const pidOf = async (c: pg.Client) => one((await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows).pid;
const admin = async <T extends pg.QueryResultRow>(sql: string) => {
  const c = await client(ADMIN);
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
};

let poolSize = 0;
beforeAll(async () => {
  const config = Object.fromEntries((await admin<{ key: string; value: string }>('SHOW CONFIG')).map((r) => [r.key, r.value]));
  expect(config.pool_mode).toBe('transaction');
  expect(config.max_prepared_statements).toBe('0');
  poolSize = Number(config.default_pool_size);
  // 20 clients must outnumber the backends, or sharing (and so PB1 and PB2) would not be certain.
  expect(poolSize).toBeGreaterThan(0);
  expect(poolSize).toBeLessThan(20);
}, 30_000);

describe("[LS5][PB1] transaction pooling is real in the stack's PgBouncer", () => {
  it('[PB1] 20 connected clients share at most default_pool_size backends, some backend serving several clients; a session-level canary leaks', async () => {
    const clients = await Promise.all(Array.from({ length: 20 }, () => client(BOUNCER_PLATFORM, UTC)));
    try {
      const servedBy = new Map<number, Set<number>>();
      for (let round = 0; round < 10; round++)
        await Promise.all(
          clients.map(async (c, i) => {
            await c.query('BEGIN');
            const pid = await pidOf(c);
            await c.query('COMMIT');
            servedBy.set(pid, (servedBy.get(pid) ?? new Set()).add(i));
          }),
        );
      const shown = (await admin<{ database: string }>('SHOW CLIENTS')).filter((r) => r.database === 'univarse_platform');
      expect(shown.length).toBeGreaterThanOrEqual(20);
      expect(servedBy.size).toBeLessThanOrEqual(poolSize);
      // More clients than backends: by pigeonhole at least one backend served two different clients.
      expect(Math.max(...[...servedBy.values()].map((s) => s.size))).toBeGreaterThanOrEqual(2);

      const canary = randomBytes(8).toString('hex');
      const pid0 = one((await at(clients, 0).query<{ pid: number }>("SELECT pg_backend_pid() AS pid, set_config('uv.canary', $1, false)", [canary])).rows).pid;
      let seen: string | null = null;
      for (let attempt = 0; attempt < 400 && seen === null; attempt++) {
        const r = one((await at(clients, 1 + (attempt % 19)).query<{ pid: number; v: string | null }>("SELECT pg_backend_pid() AS pid, current_setting('uv.canary', true) AS v")).rows);
        if (r.pid === pid0) seen = r.v;
      }
      expect(seen).toBe(canary);
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
      await admin('RECONNECT univarse_platform'); // the canary must not outlive this test
    }
  }, 120_000);
});

describe("[LS5][PB2] the tenant context never crosses clients in the stack's PgBouncer", () => {
  let shard: TenantShardClient;
  const fixtures: { tenantId: string; values: string[] }[] = [];
  const PREFIX = `pb2.stack.${randomBytes(4).toString('hex')}.`;

  beforeAll(async () => {
    shard = createTenantShardClient(BOUNCER_TENANT);
    const platform = createPlatformClient(BOUNCER_PLATFORM);
    try {
      for (const slug of ['demo-uni', 'test-poly']) {
        const tenantId = (await platform.tenant.findUniqueOrThrow({ where: { slug } })).id;
        const values = Array.from({ length: 5 }, () => `${PREFIX}${slug}.${randomBytes(4).toString('hex')}`);
        await withTenantTx(shard, tenantId, (tx) => tx.outboxEvent.createMany({ data: values.map((type) => ({ tenantId, type, status: 'DEAD' as const })) }));
        fixtures.push({ tenantId, values });
      }
    } finally {
      await platform.$disconnect();
    }
  }, 60_000);

  afterAll(async () => {
    await shard.$disconnect();
    // Exactly this run's rows, as the superuser inside the PostgreSQL container (its password by environment name).
    if (!/^pb2\.stack\.[0-9a-f]{8}\.$/.test(PREFIX)) throw new Error('unexpected fixture prefix');
    const r = docker(
      ['exec', '-e', 'PGPASSWORD', `${PROJECT}-postgres-1`, 'psql', '-U', 'postgres', '-d', 'univarse_pool_01', '-At', '-c', `WITH d AS (DELETE FROM outbox_event WHERE type LIKE '${PREFIX}%' RETURNING 1) SELECT count(*) FROM d`],
      { env: { PGPASSWORD: loadSecrets().postgresSuperuser } },
    );
    expect(Number(r.stdout.trim())).toBe(fixtures.reduce((n, f) => n + f.values.length, 0));
  }, 60_000);

  it('[PB2] the check itself fails on swapped tenants with equal counts (ids and values, not only counts)', () => {
    const a = at(fixtures, 0);
    const b = at(fixtures, 1);
    expect(tenantRowProblems(b.values.map((type) => ({ tenantId: b.tenantId, type })), a)).toEqual(['a row of another tenant', 'the wrong values']);
  });

  it('[PB2] 1 000 interleaved reads, both paths, random order: each tenant sees exactly its rows', async () => {
    const order = Array.from({ length: 1000 }, (_, i) => i).sort(() => Math.random() - 0.5);
    const failures: string[] = [];
    const read = async (i: number) => {
      const f = at(fixtures, i % 2);
      const viaTx = i % 4 < 2;
      const where = { type: { startsWith: PREFIX } };
      const select = { tenantId: true, type: true } as const;
      const rows = viaTx
        ? await withTenantTx(shard, f.tenantId, (tx) => tx.outboxEvent.findMany({ where, select }))
        : await forTenant(shard, f.tenantId).outboxEvent.findMany({ where, select });
      for (const p of tenantRowProblems(rows, f)) failures.push(`#${String(i)} (${viaTx ? 'withTenantTx' : 'forTenant'}): ${p}`);
    };
    for (let k = 0; k < order.length; k += 8) await Promise.all(order.slice(k, k + 8).map(read));
    expect(failures).toEqual([]);
  }, 300_000);

  it('[PB2] after a tenant transaction, a context-free query on the same backend sees no context and no rows', async () => {
    const f = at(fixtures, 0);
    const raw = await client(BOUNCER_TENANT, UTC);
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        const tenantPid = await withTenantTx(shard, f.tenantId, async (tx) => one(await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`).pid);
        const r = one((await raw.query<{ pid: number; ctx: string | null; n: string }>("SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS ctx, (SELECT count(*) FROM outbox_event) AS n")).rows);
        if (r.pid !== tenantPid) continue;
        expect(r.ctx ?? '').toBe('');
        expect(Number(r.n)).toBe(0); // RLS default deny
        return;
      }
      throw new Error('never reached the tenant transaction’s backend in 200 attempts');
    } finally {
      await raw.end();
    }
  }, 120_000);
});
