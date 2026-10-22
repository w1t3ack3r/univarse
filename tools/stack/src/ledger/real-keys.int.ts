// Spec 0020 BK1, BK2, BK11, BK14 (A2-13): the destruction protocol against the REAL keys CLI (apps/api's build) and the
// real platform database, as CI sets them up (db:setup, db:migrate, Vault). Run by `pnpm --filter @univarse/stack
// test:ledger`, never by the unit run. Scratch tenants only (OFFBOARDING), with no encrypted values.
// "Total stack loss" is staged as A2-12 states: the superuser puts back what the protocol reads, as an older backup
// would hold it: the scratch tenants' key rows, the destruction rows, and the platform audit chain after the snapshot
// point (the chain stays valid: it is cut back to an earlier head, exactly as a restore would). PR B's shred drill
// restores a whole database.
// It runs on CI's disposable database only (CI=true): it clears the key_destruction rows other suites left, so one
// ledger can account for every row, and its cases share that ledger, in order.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opStates, type Destination } from './chain.js';
import { init } from './commands.js';
import { keysDbFrom, type Runner } from './job.js';
import { establishAuthority } from './ledger.js';
import { destroy, recover, type ProtocolDeps } from './protocol.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI = join(REPO, 'apps', 'api', 'dist', 'cli', 'keys.js');
const rootEnv = join(REPO, '.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
const run = randomBytes(3).toString('hex');

/** The keys CLI run directly with Node, as the job runs it in the image (the root .env gives it the databases). */
const nodeRunner: Runner = (args, opts = {}) => {
  const r = spawnSync(process.execPath, ['--enable-source-maps', CLI, ...args], {
    cwd: join(REPO, 'apps', 'api'),
    encoding: 'utf8',
    timeout: 120_000,
    ...(opts.input === undefined ? {} : { input: opts.input }),
    env: { ...process.env, NODE_ENV: 'test', ...(opts.op ? { UNIVARSE_DESTRUCTION_OP: opts.op } : {}) },
  });
  return { status: r.error ? null : r.status, stdout: r.stdout, stderr: r.stderr };
};

let app: pg.Client | undefined; // the platform app role
let su: pg.Client | undefined; // the superuser: only to stage an older database
let shardId = '';
let dir = '';
let primary: Destination = { id: 'primary', path: '' };
class Crash extends Error {}

const deps = (over: Partial<ProtocolDeps> = {}): ProtocolDeps => ({
  primary,
  db: keysDbFrom(nodeRunner),
  lock: () => Promise.resolve({ release: () => undefined }),
  log: () => undefined,
  ...over,
});
const crashAt = (point: string) =>
  deps({
    crash: (p) => {
      if (p === point) throw new Crash(p);
    },
  });
const A = () => app ?? (() => { throw new Error('not connected'); })();
const S = () => su ?? (() => { throw new Error('not connected'); })();
const entries = () => {
  const a = establishAuthority(primary);
  if (!a.ok) throw new Error(a.problems.join('\n'));
  return a.entries;
};
const outcomeOf = (op: string) => opStates(entries()).ops.get(op)?.outcome?.type ?? 'pending';
const pendingOp = () => [...opStates(entries()).ops.values()].find((s) => !s.outcome)?.pending.op ?? '';

beforeAll(async () => {
  if (process.env.CI !== 'true') throw new Error("the ledger integration test runs on CI's disposable database only (CI=true)");
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build the API first`);
  app = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
  await app.connect();
  su = new pg.Client({ host: process.env.PGHOST ?? '127.0.0.1', port: Number(process.env.PGPORT ?? 5432), user: 'postgres', password: process.env.PGSUPERPASSWORD, database: 'univarse_platform' });
  await su.connect();
  shardId = (await app.query<{ id: string }>('SELECT id::text FROM shard WHERE is_active LIMIT 1')).rows[0]?.id ?? '';
  await su.query('DELETE FROM key_destruction'); // other suites' rows (CI only, above): this ledger must account for every row
  dir = mkdtempSync(join(tmpdir(), 'uv-ledger-int-'));
  primary = { id: 'primary', path: join(dir, 'primary') };
  const r = await init(deps(), [join(dir, 'external')]);
  if (!r.ok) throw new Error(r.lines.join('\n'));
});
afterAll(async () => {
  await app?.end();
  await su?.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A scratch tenant: v1 RETIRED (eligible under D15: retired 2 h ago, a clean sweep started since), v2 ACTIVE. */
async function scratch(label: string, opts: { eligible?: boolean } = {}): Promise<{ id: string; slug: string }> {
  const slug = `ledger-${label}-${run}`;
  const id = randomUUID();
  await A().query(
    `INSERT INTO tenant (id, slug, legal_name, short_name, type, ownership, status, shard_id, updated_at)
     VALUES ($1, $2, $3, $4, 'UNIVERSITY', 'PRIVATE', 'OFFBOARDING', $5, now())`,
    [id, slug, `Ledger ${label}`, `LDG-${label}`.toUpperCase().slice(0, 20), shardId],
  );
  await A().query(
    `INSERT INTO tenant_data_key (tenant_id, version, status, kek_id, wrapped_dek, retired_at) VALUES
     ($1, 1, 'RETIRED', 'test', 'not-a-real-wrap', now() - interval '2 hours'), ($1, 2, 'ACTIVE', 'test', 'not-a-real-wrap', NULL)`,
    [id],
  );
  if (opts.eligible !== false)
    await A().query(
      `INSERT INTO key_reencryption (tenant_id, reason, requested_at, started_at, completed_at, unreadable_remaining)
       VALUES ($1, 'ROTATION', now(), now(), now() + interval '1 millisecond', 0)`,
      [id],
    );
  return { id, slug };
}

const keyStates = async (tenantId: string) =>
  Object.fromEntries(
    (await A().query<{ version: number; status: string; wrapped_dek: string | null }>('SELECT version, status::text AS status, wrapped_dek FROM tenant_data_key WHERE tenant_id = $1 ORDER BY version', [tenantId])).rows.map((r) => [
      r.version,
      r.wrapped_dek === null ? `${r.status}/erased` : r.status,
    ]),
  );

interface Snapshot {
  readonly maxSeq: string;
  readonly ops: string[];
  readonly keys: { tenant_id: string; version: number; status: string; wrapped_dek: string | null; destroyed_at: Date | null }[];
}
async function snapshot(tenantIds: string[]): Promise<Snapshot> {
  return {
    maxSeq: (await S().query<{ m: string | null }>('SELECT max(seq)::text AS m FROM platform_audit_event')).rows[0]?.m ?? '0',
    ops: (await S().query<{ op: string }>('SELECT op::text AS op FROM key_destruction')).rows.map((r) => r.op),
    keys: (await S().query<Snapshot['keys'][number]>('SELECT tenant_id::text AS tenant_id, version, status::text AS status, wrapped_dek, destroyed_at FROM tenant_data_key WHERE tenant_id = ANY($1::uuid[])', [tenantIds])).rows,
  };
}
/** The platform DB as the older backup held it (for what the protocol reads). */
async function restore(s: Snapshot): Promise<void> {
  await S().query('BEGIN');
  await S().query('DELETE FROM key_destruction WHERE NOT (op = ANY($1::uuid[]))', [s.ops]);
  await S().query('DELETE FROM platform_audit_event WHERE seq > $1::bigint', [s.maxSeq]);
  for (const k of s.keys)
    await S().query('UPDATE tenant_data_key SET status = $3::"DataKeyStatus", wrapped_dek = $4, destroyed_at = $5 WHERE tenant_id = $1::uuid AND version = $2', [k.tenant_id, k.version, k.status, k.wrapped_dek, k.destroyed_at]);
  await S().query('COMMIT');
}

describe('[BK1][BK2][BK11] the protocol with the real keys CLI and database', { timeout: 600_000 }, () => {
  it('[BK1] a whole-tenant destruction: accepted only once committed, recorded with its row and audit event', async () => {
    const t = await scratch('tenant');
    const r = await destroy(deps(), { slug: t.slug });
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(await keyStates(t.id)).toEqual({ 1: 'DESTROYED/erased', 2: 'DESTROYED/erased' });
    expect(outcomeOf(r.op ?? '')).toBe('committed');
    const row = (await A().query<{ kind: string; versions: number[]; audit_seq: string }>('SELECT kind::text AS kind, versions, audit_seq::text AS audit_seq FROM key_destruction WHERE op = $1', [r.op])).rows[0];
    expect(row).toMatchObject({ kind: 'TENANT', versions: [1, 2] });
    expect(entries().find((e) => e.type === 'committed')).toMatchObject({ auditSeq: row?.audit_seq, by: 'destroy' });
  });

  it('[BK1] refused by the read-only check: nothing is written', async () => {
    const t = await scratch('unready', { eligible: false });
    const n = entries().length;
    const r = await destroy(deps(), { slug: t.slug, version: 1 });
    expect(r.lines.join()).toMatch(/refused before anything was written: sweep_pending/);
    expect(entries()).toHaveLength(n);
    expect(await keyStates(t.id)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
  });

  it('[BK1][BK14] a precondition broken between the check and the transaction: refused inside it, recorded aborted, nothing destroyed', async () => {
    const t = await scratch('broken');
    const real = keysDbFrom(nodeRunner);
    // The check passes; then the sweep is re-requested (completed_at cleared) before the transaction runs.
    const racing = {
      ...real,
      check: async (slug: string, v?: number) => {
        const c = await real.check(slug, v);
        await A().query('UPDATE key_reencryption SET completed_at = NULL WHERE tenant_id = $1', [t.id]);
        return c;
      },
    };
    const r = await destroy(deps({ db: racing }), { slug: t.slug, version: 1 });
    expect(r.ok).toBe(false);
    expect(r.lines.join()).toMatch(/refused by the database, nothing destroyed: sweep_pending \(recorded as aborted\)/);
    expect(outcomeOf(r.op ?? '')).toBe('aborted');
    expect(await keyStates(t.id)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
  });

  it('[BK11] the commit boundary: committed, then stopped before `committed` reached the ledger; recovery records it once from the evidence', async () => {
    const t = await scratch('boundary');
    await expect(destroy(crashAt('db:after'), { slug: t.slug, version: 1 })).rejects.toBeInstanceOf(Crash);
    const op = pendingOp();
    const r = await recover(deps());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(outcomeOf(op)).toBe('committed');
    expect(entries().find((e) => e.type === 'committed' && e.op === op)).toMatchObject({ by: 'recovery' });
    expect((await A().query<{ n: number }>("SELECT count(*)::int AS n FROM platform_audit_event WHERE metadata->>'op' = $1", [op])).rows[0]).toEqual({ n: 1 });
    expect(await keyStates(t.id)).toEqual({ 1: 'DESTROYED/erased', 2: 'ACTIVE' });
  });

  it('[BK11] the commit boundary with conflicting evidence (a key not DESTROYED) stops recovery', async () => {
    const t = await scratch('conflict');
    await expect(destroy(crashAt('db:after'), { slug: t.slug, version: 1 })).rejects.toBeInstanceOf(Crash);
    await S().query("UPDATE tenant_data_key SET status = 'RETIRED', wrapped_dek = 'not-a-real-wrap' WHERE tenant_id = $1 AND version = 1", [t.id]);
    const r = await recover(deps());
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/conflicting evidence: its keys are not all destroyed/);
    // Put right (as the owner would, after investigating), so the cases after this one start from a sound ledger.
    await S().query("UPDATE tenant_data_key SET status = 'DESTROYED', wrapped_dek = NULL WHERE tenant_id = $1 AND version = 1", [t.id]);
    expect((await recover(deps())).ok).toBe(true);
  });

  it('[BK11] the older database: stopped after the transaction, then the database restored from before it; recovery replays it', async () => {
    const t = await scratch('older');
    const older = await snapshot([t.id]);
    await expect(destroy(crashAt('db:after'), { slug: t.slug, version: 1 })).rejects.toBeInstanceOf(Crash);
    const op = pendingOp();
    await restore(older);
    expect((await A().query('SELECT 1 FROM key_destruction WHERE op = $1', [op])).rowCount).toBe(0);
    const r = await recover(deps());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(outcomeOf(op)).toBe('committed');
    expect(await keyStates(t.id)).toEqual({ 1: 'DESTROYED/erased', 2: 'ACTIVE' });
  });

  it('[BK2] an accepted destruction undone by a restore is destroyed again and audited as re-applied', async () => {
    const t = await scratch('reapply');
    const older = await snapshot([t.id]);
    const done = await destroy(deps(), { slug: t.slug });
    expect(done.ok, done.lines.join('\n')).toBe(true);
    await restore(older);
    expect(await keyStates(t.id)).toEqual({ 1: 'RETIRED', 2: 'ACTIVE' });
    const r = await recover(deps());
    expect(r.ok, r.lines.join('\n')).toBe(true);
    expect(await keyStates(t.id)).toEqual({ 1: 'DESTROYED/erased', 2: 'DESTROYED/erased' });
    const audit = (await A().query<{ action: string }>("SELECT action FROM platform_audit_event WHERE metadata->>'op' = $1 ORDER BY seq", [done.op])).rows;
    expect(audit.map((a) => a.action)).toEqual(['crypto.tenant_key.reapplied']);
    expect(entries().filter((e) => e.type === 'reapplied')).toHaveLength(1);
    // A second recovery finds everything in force and changes nothing.
    const n = entries().length;
    expect((await recover(deps())).ok).toBe(true);
    expect(entries()).toHaveLength(n);
  });
});
