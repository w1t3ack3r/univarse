/**
 * Spec 0017: the pooling probes, through PgBouncer in TRANSACTION mode with the PROBE profile (default_pool_size 2),
 * where sharing and saturation are certain. Run with `pnpm test:int:pgbouncer` (or the pgbouncer-isolation CI job):
 * it needs PgBouncer up in the probe profile (tools/pgbouncer/run.mjs start probe) and the env db:setup writes.
 * PB5 and the PB9 rotation also need the superuser (PGHOST, PGPORT, PGSUPERPASSWORD), as CI provides; the rotation
 * re-runs db:setup, so it rotates the local passwords, and runs only with PGBOUNCER_PROBE_ROTATION=1.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient as PlatformPrisma } from '../src/generated/platform/client.js';
import { createPlatformClient } from '../src/platform.js';
import { POOL_OPTIONS } from '../src/pool.js';
import {
  createTenantShardClient,
  forTenant,
  withTenantTx,
  type TenantShardClient,
} from '../src/tenant.js';
import { loadRootEnv, REPO_ROOT, requireEnv } from '../scripts/env.js';
import { ownerOnlyProblems } from '../scripts/pgbouncer-config.js';

loadRootEnv();
const BOUNCER_PLATFORM = requireEnv('PGBOUNCER_PLATFORM_DATABASE_URL');
const BOUNCER_TENANT = requireEnv('PGBOUNCER_TENANT_POOL_01_DATABASE_URL');
const ADMIN = requireEnv('PGBOUNCER_ADMIN_URL');
const DIRECT_PLATFORM = requireEnv('PLATFORM_DATABASE_URL');
const superuserUrl = (db = 'postgres') => {
  const pw = process.env.PGSUPERPASSWORD;
  if (!pw) throw new Error('PB5 / PB9 rotation need PGSUPERPASSWORD (CI provides it)');
  return `postgresql://${process.env.PGSUPERUSER ?? 'postgres'}:${encodeURIComponent(pw)}@${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/${db}`;
};

const UTC = '-c TimeZone=UTC';
const client = async (url: string, options?: string) => {
  const c = new pg.Client({ connectionString: url, ...(options ? { options } : {}) });
  c.on('error', () => {}); // a server-side close is asserted on, never an unhandled event
  await c.connect();
  return c;
};
const pidOf = async (c: pg.Client) =>
  (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
const admin = async <T extends pg.QueryResultRow>(sql: string) => {
  const c = await client(ADMIN);
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
};
/** Every server connection of the pool for this database: closed, so the next ones are new backends. */
const recycle = async (db: string) => {
  await admin(`RECONNECT ${db}`);
  // RECONNECT closes idle server connections at once and active ones when they're released: wait until none is old.
  for (let i = 0; i < 40; i++) {
    const servers = await admin<{ database: string }>('SHOW SERVERS');
    if (!servers.some((s) => s.database === db)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  // The probe profile, or every sharing assertion below is meaningless.
  const config = Object.fromEntries(
    (await admin<{ key: string; value: string }>('SHOW CONFIG')).map((r) => [r.key, r.value]),
  );
  expect(config.pool_mode).toBe('transaction');
  expect(config.default_pool_size).toBe('2');
  expect(config.max_prepared_statements).toBe('0');
  expect(config.query_wait_timeout).toBe('2');
}, 30_000);

describe('[PB1] transaction pooling is real (probe profile)', () => {
  it('[PB1] 20 connected clients share at most 2 backends, each backend serving several clients; a session-level canary leaks', async () => {
    const clients = await Promise.all(
      Array.from({ length: 20 }, () => client(BOUNCER_PLATFORM, UTC)),
    );
    try {
      const servedBy = new Map<number, Set<number>>(); // pid → client indices
      for (let round = 0; round < 10; round++)
        await Promise.all(
          clients.map(async (c, i) => {
            await c.query('BEGIN');
            const pid = await pidOf(c);
            await c.query('COMMIT');
            servedBy.set(pid, (servedBy.get(pid) ?? new Set()).add(i));
          }),
        );
      // While all 20 are still connected: PgBouncer's own view, and the clients' own state.
      const shown = (await admin<{ database: string; state: string }>('SHOW CLIENTS')).filter(
        (r) => r.database === 'univarse_platform',
      );
      expect(shown.length).toBeGreaterThanOrEqual(20);
      expect(clients.every((c) => !(c as unknown as { _ending: boolean })._ending)).toBe(true);
      expect(servedBy.size).toBeLessThanOrEqual(2);
      for (const [pid, served] of servedBy)
        expect(served.size, `backend ${pid}`).toBeGreaterThanOrEqual(2);

      // The canary: session state set by client 0 is read by another client on the same backend.
      const canary = randomBytes(8).toString('hex');
      const c0 = clients[0]!;
      const pid0 = (
        await c0.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid, set_config('uv.canary', $1, false)",
          [canary],
        )
      ).rows[0]!.pid;
      let seen: string | null = null;
      for (let attempt = 0; attempt < 200 && seen === null; attempt++) {
        const other = clients[1 + (attempt % 19)]!;
        const r = (
          await other.query<{ pid: number; v: string | null }>(
            "SELECT pg_backend_pid() AS pid, current_setting('uv.canary', true) AS v",
          )
        ).rows[0]!;
        if (r.pid === pid0) seen = r.v;
      }
      expect(seen).toBe(canary);
    } finally {
      await Promise.all(clients.map((c) => c.end().catch(() => {})));
      await recycle('univarse_platform'); // the canary must not outlive this test
    }
  }, 60_000);
});

/** Tenant rows as read, against what that tenant must see: exactly its ids, its values, its count. */
export function tenantRowProblems(
  rows: { tenantId: string; type: string }[],
  expected: { tenantId: string; values: string[] },
): string[] {
  const problems: string[] = [];
  if (rows.some((r) => r.tenantId !== expected.tenantId)) problems.push('a row of another tenant');
  const values = rows.map((r) => r.type).sort();
  if (JSON.stringify(values) !== JSON.stringify([...expected.values].sort()))
    problems.push('the wrong values');
  if (rows.length !== expected.values.length)
    problems.push(`${rows.length} rows, expected ${expected.values.length}`);
  return problems;
}

describe('[PB2] the tenant context never crosses clients (probe profile)', () => {
  let shard: TenantShardClient;
  let platform: PlatformPrisma;
  const fixtures: { tenantId: string; values: string[] }[] = [];
  const PREFIX = `pb2.${randomBytes(4).toString('hex')}.`;

  beforeAll(async () => {
    shard = createTenantShardClient(BOUNCER_TENANT);
    platform = createPlatformClient(BOUNCER_PLATFORM);
    for (const slug of ['demo-uni', 'test-poly']) {
      const tenantId = (await platform.tenant.findUniqueOrThrow({ where: { slug } })).id;
      // The same number of rows for both tenants, each with a distinct per-tenant marker.
      const values = Array.from(
        { length: 5 },
        () => `${PREFIX}${slug}.${randomBytes(4).toString('hex')}`,
      );
      await withTenantTx(shard, tenantId, (tx) =>
        tx.outboxEvent.createMany({
          data: values.map((type) => ({ tenantId, type, status: 'DEAD' as const })),
        }),
      );
      fixtures.push({ tenantId, values });
    }
  }, 30_000);
  afterAll(async () => {
    for (const f of fixtures)
      await withTenantTx(shard, f.tenantId, (tx) =>
        tx.outboxEvent.deleteMany({ where: { type: { startsWith: PREFIX } } }),
      );
    await shard.$disconnect();
    await platform.$disconnect();
  });

  it('[PB2] the check itself fails on swapped tenants with equal counts (ids and values, not only counts)', () => {
    const [a, b] = fixtures;
    const bRows = b!.values.map((type) => ({ tenantId: b!.tenantId, type }));
    expect(tenantRowProblems(bRows, a!)).toEqual(['a row of another tenant', 'the wrong values']);
  });

  it('[PB2] 1 000 interleaved reads, both paths, random order, over 2 server connections: each sees exactly its rows', async () => {
    const order = Array.from({ length: 1000 }, (_, i) => i).sort(() => Math.random() - 0.5);
    const failures: string[] = [];
    const read = async (i: number) => {
      const f = fixtures[i % 2]!;
      const viaTx = i % 4 < 2;
      const rows = viaTx
        ? await withTenantTx(shard, f.tenantId, (tx) =>
            tx.outboxEvent.findMany({
              where: { type: { startsWith: PREFIX } },
              select: { tenantId: true, type: true },
            }),
          )
        : await forTenant(shard, f.tenantId).outboxEvent.findMany({
            where: { type: { startsWith: PREFIX } },
            select: { tenantId: true, type: true },
          });
      for (const p of tenantRowProblems(rows, f))
        failures.push(`#${i} (${viaTx ? 'withTenantTx' : 'forTenant'}): ${p}`);
    };
    for (let k = 0; k < order.length; k += 8) await Promise.all(order.slice(k, k + 8).map(read)); // 8 at a time
    expect(failures).toEqual([]);
  }, 120_000);

  it('[PB2] after a tenant transaction, a context-free query on the same backend sees no context and no rows', async () => {
    const f = fixtures[0]!;
    const raw = await client(BOUNCER_TENANT, UTC);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const tenantPid = await withTenantTx(
          shard,
          f.tenantId,
          async (tx) =>
            (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid,
        );
        const r = (
          await raw.query<{ pid: number; ctx: string | null; n: string }>(
            "SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS ctx, (SELECT count(*) FROM outbox_event) AS n",
          )
        ).rows[0]!;
        if (r.pid !== tenantPid) continue; // not the same backend this time
        expect(r.ctx ?? '').toBe('');
        expect(Number(r.n)).toBe(0); // RLS default deny
        return;
      }
      throw new Error('never reached the tenant transaction’s backend in 20 attempts');
    } finally {
      await raw.end();
    }
  }, 60_000);
});

describe('[PB5] UTC survives pooling, in two independent halves, each on fresh sessions (D6)', () => {
  const role = 'univarse_app_platform';
  const setRoleDefault = async (tz: string) => {
    const su = await client(superuserUrl());
    try {
      await su.query(`ALTER ROLE ${role} SET timezone = '${tz}'`);
    } finally {
      await su.end();
    }
  };
  /** Recycles the pool, then reads TimeZone on fresh clients until both backends have answered; all must be new. */
  const freshZones = async (options?: string) => {
    const before = new Set(
      // The admin console's column type isn't pg's: normalised, or "is new" could pass by comparing a string to a number.
      (await admin<{ remote_pid: number | string }>('SHOW SERVERS')).map((s) =>
        Number(s.remote_pid),
      ),
    );
    await recycle('univarse_platform');
    const seen = new Map<number, string>();
    for (let i = 0; i < 12; i++) {
      const c = await client(BOUNCER_PLATFORM, options);
      const r = (
        await c.query<{ pid: number; tz: string }>(
          "SELECT pg_backend_pid() AS pid, current_setting('TimeZone') AS tz",
        )
      ).rows[0]!;
      seen.set(r.pid, r.tz);
      await c.end();
    }
    for (const pid of seen.keys()) expect(before.has(pid), `backend ${pid} is not new`).toBe(false);
    return [...seen.values()];
  };
  afterAll(async () => {
    await setRoleDefault('UTC'); // as db:setup leaves it
    await recycle('univarse_platform');
  });

  it('[PB5] the option propagates: with a non-UTC role default, no option sees it, and -c TimeZone=UTC overrides it', async () => {
    await setRoleDefault('Africa/Lagos');
    const baseline = await freshZones();
    expect(baseline.length).toBeGreaterThan(0);
    expect(new Set(baseline)).toEqual(new Set(['Africa/Lagos'])); // the default really took effect on fresh sessions
    const overridden = await freshZones(UTC);
    expect(new Set(overridden)).toEqual(new Set(['UTC']));
  }, 60_000);

  it('[PB5] the role default applies: with it set to UTC, a fresh client sending no option sees UTC', async () => {
    await setRoleDefault('UTC');
    expect(new Set(await freshZones())).toEqual(new Set(['UTC']));
  }, 60_000);
});

describe('[PB6] no reliance on named prepared statements', () => {
  const NAMED = 'SELECT 41 + 1 AS answer';
  /** The mutant: a client that names exactly one query with a stable name (PB6). */
  const mutant = (url: string) =>
    new PlatformPrisma({
      adapter: new PrismaPg(
        { connectionString: url, options: UTC, ...POOL_OPTIONS, max: 1 },
        { statementNameGenerator: (q) => (q.sql.includes('41 + 1') ? 'uv_pb6_stable' : '') },
      ),
    });
  const answer = (p: PlatformPrisma) => p.$queryRawUnsafe<{ answer: number }[]>(NAMED);

  it('[PB6] PgBouncer tracks no prepared statements (max_prepared_statements = 0)', async () => {
    const config = await admin<{ key: string; value: string }>('SHOW CONFIG');
    expect(config.find((r) => r.key === 'max_prepared_statements')?.value).toBe('0');
  });

  it('[PB6] a stably named statement fails once its client is forced onto another backend', async () => {
    const p = mutant(BOUNCER_PLATFORM);
    const holders: pg.Client[] = [];
    try {
      await answer(p); // prepared, by name, on some backend P1
      const p1 = (await p.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0]!
        .pid;
      // Hold P1 busy in another client's open transaction (LIFO reuse puts it there; checked by pid).
      for (let i = 0; i < 10; i++) {
        const h = await client(BOUNCER_PLATFORM, UTC);
        await h.query('BEGIN');
        holders.push(h);
        if ((await pidOf(h)) === p1) break;
        await h.query('COMMIT');
        holders.pop();
        await h.end();
      }
      expect(holders.length, 'could not hold the first backend').toBe(1);
      const p2 = (await p.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0]!
        .pid;
      expect(p2).not.toBe(p1);
      await expect(answer(p)).rejects.toThrow(/prepared statement "uv_pb6_stable" does not exist/);
    } finally {
      for (const h of holders)
        await h
          .query('ROLLBACK')
          .then(() => h.end())
          .catch(() => {});
      await p.$disconnect();
    }
  }, 60_000);

  it('[PB6] the control: the same mutant against PostgreSQL directly succeeds, again and again', async () => {
    const p = mutant(DIRECT_PLATFORM);
    try {
      for (let i = 0; i < 3; i++) expect((await answer(p))[0]!.answer).toBe(42);
    } finally {
      await p.$disconnect();
    }
  });
});

describe('[PB9] authentication, credentials and exposure', () => {
  it('[PB9] each app role authenticates through PgBouncer under its own name; a wrong password is refused', async () => {
    for (const [url, role] of [
      [BOUNCER_PLATFORM, 'univarse_app_platform'],
      [BOUNCER_TENANT, 'univarse_app'],
    ] as const) {
      const c = await client(url, UTC);
      expect((await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u).toBe(role);
      await c.end();
      const wrong = new pg.Client({
        connectionString: url.replace(/:([^:@/]+)@/, ':wrong-password@'),
      });
      await expect(wrong.connect()).rejects.toThrow(
        /SASL authentication failed|password authentication failed/,
      );
    }
  });

  it('[PB9] the admin console is pgbouncer_admin only: not an app role, and not a PostgreSQL role', async () => {
    const asApp = new pg.Client({
      connectionString: BOUNCER_PLATFORM.replace(/\/univarse_platform$/, '/pgbouncer'),
    });
    asApp.on('error', () => {});
    await expect(asApp.connect().then(() => asApp.query('SHOW POOLS'))).rejects.toThrow();
    await asApp.end().catch(() => {});
    const adminDirect = new pg.Client({
      connectionString: ADMIN.replace(
        /@127\.0\.0\.1:6432\/pgbouncer$/,
        `@${process.env.PGHOST ?? '127.0.0.1'}:${process.env.PGPORT ?? '5432'}/postgres`,
      ),
    });
    await expect(adminDirect.connect()).rejects.toThrow(); // no such role in PostgreSQL
  });

  it('[PB9] the auth file is owner-only and mounted read-only', () => {
    expect(ownerOnlyProblems(join(REPO_ROOT, '.pgbouncer', 'userlist.txt'))).toEqual([]);
    const mounts = JSON.parse(
      execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', 'univarse-pgbouncer'], {
        encoding: 'utf8',
      }),
    ) as { Destination: string; RW: boolean }[];
    // The directory, read-only (a single-file mount would pin the old auth file across a rotation).
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatchObject({ Destination: '/etc/pgbouncer', RW: false });
  });

  it.runIf(process.env.PGBOUNCER_PROBE_ROTATION === '1')(
    '[PB9] rotation: db:setup changes the passwords and regenerates the file; after RELOAD the new one works and the old one is refused',
    async () => {
      const old = BOUNCER_PLATFORM;
      // The admin credentials PgBouncer has loaded now: the RELOAD must come from them, before the new ones exist.
      const adminOld = await client(ADMIN);
      execFileSync('pnpm', ['db:setup'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      const env = Object.fromEntries(
        (await import('node:fs'))
          .readFileSync(join(REPO_ROOT, '.env'), 'utf8')
          .split(/\r?\n/)
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      const fresh = env.PGBOUNCER_PLATFORM_DATABASE_URL!;
      // Compared without printing either: a failed expect would show both URLs, passwords included.
      expect(fresh === old, 'db:setup must have changed the password').toBe(false);
      await adminOld.query('RELOAD');
      await adminOld.end();
      const c = await client(fresh, UTC);
      expect((await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u).toBe(
        'univarse_app_platform',
      );
      await c.end();
      const stale = new pg.Client({ connectionString: old });
      await expect(stale.connect()).rejects.toThrow(
        /SASL authentication failed|password authentication failed/,
      );
    },
    60_000,
  );
});
