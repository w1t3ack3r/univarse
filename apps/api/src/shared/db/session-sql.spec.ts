// Spec 0017 PB4: no session-scoped SQL in production code (see testing/session-sql-guard.ts). The current code
// passes; every form has a fixture, compiled with the real types, so the check sees exactly what it sees in
// production; and comments, literals and Prisma's raw APIs can't hide one.
import type * as TS from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeSessionSql,
  packageProgram,
  sessionSqlProblems,
  sessionSqlScan,
} from '../../testing/session-sql-guard.js';

const HEAD = `import type { PlatformClient } from '@univarse/db';\nimport { PlatformModels } from '@univarse/db';\nvoid PlatformModels;\n`;
/** A fixture running `sql` through $executeRawUnsafe (a substitution-free literal). */
const unsafe = (sql: string) =>
  `${HEAD}export async function f(p: PlatformClient) { await p.$executeRawUnsafe(${JSON.stringify(sql)}); }`;

/** One fixture per PB4 form, each with the problem it must report. */
const FORMS: Record<string, [string, RegExp]> = {
  setSession: [unsafe('SET SESSION statement_timeout = 0'), /SET without LOCAL \(SET SESSION\)/],
  setRole: [unsafe('SET ROLE univarse_app'), /SET without LOCAL \(SET ROLE\)/],
  setSessionAuthorization: [
    unsafe('SET SESSION AUTHORIZATION univarse_app'),
    /SET without LOCAL \(SET SESSION\)/,
  ],
  setPlain: [unsafe('SET search_path = public'), /SET without LOCAL \(SET SEARCH_PATH\)/],
  setTimeZone: [unsafe("SET TIME ZONE 'UTC'"), /SET without LOCAL \(SET TIME\)/],
  reset: [unsafe('RESET search_path'), /RESET is session-scoped/],
  resetAll: [unsafe('RESET ALL'), /RESET is session-scoped/],
  setConfigFalse: [
    unsafe("SELECT set_config('app.tenant_id', 'x', false)"),
    /set_config\(…\) whose third argument is false/,
  ],
  setConfigParam: [
    `${HEAD}export async function f(p: PlatformClient, local: boolean) { await p.$executeRaw\`SELECT set_config('app.tenant_id', 'x', \${local})\`; }`,
    /set_config\(…\) whose third argument is \$1, not a literal true/,
  ],
  setConfigStringTrue: [
    unsafe("SELECT set_config('app.tenant_id', 'x', 'true')"),
    /third argument is true, not a literal true|third argument is .*not a literal true/,
  ],
  setConfigTwoArgs: [
    unsafe("SELECT set_config('app.tenant_id', 'x')"),
    /without a readable third argument/,
  ],
  advisoryLock: [
    unsafe('SELECT pg_advisory_lock(1)'),
    /pg_advisory_lock is a session-level advisory lock/,
  ],
  advisoryLockShared: [
    unsafe('SELECT pg_advisory_lock_shared(1)'),
    /pg_advisory_lock_shared is a session-level/,
  ],
  tryAdvisoryLock: [
    unsafe('SELECT pg_try_advisory_lock(1)'),
    /pg_try_advisory_lock is a session-level/,
  ],
  tryAdvisoryLockShared: [
    unsafe('SELECT pg_try_advisory_lock_shared(1)'),
    /pg_try_advisory_lock_shared is a session-level/,
  ],
  advisoryUnlock: [unsafe('SELECT pg_advisory_unlock(1)'), /pg_advisory_unlock is a session-level/],
  advisoryUnlockShared: [
    unsafe('SELECT pg_advisory_unlock_shared(1)'),
    /pg_advisory_unlock_shared is a session-level/,
  ],
  advisoryUnlockAll: [
    unsafe('SELECT pg_advisory_unlock_all()'),
    /pg_advisory_unlock_all is a session-level/,
  ],
  listen: [unsafe('LISTEN tenant_changed'), /LISTEN is session-scoped/],
  unlisten: [unsafe('UNLISTEN *'), /UNLISTEN is session-scoped/],
  prepare: [unsafe('PREPARE q AS SELECT 1'), /PREPARE is session-scoped/],
  deallocate: [unsafe('DEALLOCATE q'), /DEALLOCATE is session-scoped/],
  createTemp: [unsafe('CREATE TEMP TABLE t (id int)'), /CREATE TEMP makes a session-scoped table/],
  createTemporary: [unsafe('CREATE TEMPORARY TABLE t (id int)'), /CREATE TEMPORARY makes/],
  createGlobalTemp: [unsafe('CREATE GLOBAL TEMPORARY TABLE t (id int)'), /CREATE TEMPORARY makes/],
  selectIntoTemp: [unsafe('SELECT 1 AS x INTO TEMP t'), /SELECT … INTO TEMP makes/],
  selectIntoTemporary: [
    unsafe('SELECT 1 AS x INTO TEMPORARY TABLE t'),
    /SELECT … INTO TEMPORARY makes/,
  ],
  declareWithHold: [
    unsafe('DECLARE c CURSOR WITH HOLD FOR SELECT 1'),
    /a cursor WITH HOLD outlives its transaction/,
  ],
  discard: [unsafe('DISCARD ALL'), /DISCARD is session-scoped/],
  // The temporary namespace makes a relation temporary without TEMP (owner's review of 6297f22).
  createInPgTemp: [
    unsafe('CREATE TABLE pg_temp.pb4_tmp (x integer)'),
    /a relation in pg_temp is temporary/,
  ],
  selectIntoPgTemp: [
    unsafe('SELECT 1 AS x INTO pg_temp.pb4_tmp'),
    /a relation in pg_temp is temporary/,
  ],
  quotedNumberedPgTemp: [
    unsafe('CREATE TABLE "pg_temp_3".t (x int)'),
    /a relation in pg_temp_3 is temporary/,
  ],
};

/** Hiding places: each must still be found (the lexer decodes them) or refused. */
const HIDDEN: Record<string, [string, RegExp]> = {
  afterBlockComment: [
    unsafe('/* SET LOCAL x = 1 */ SET ROLE univarse_app'),
    /SET without LOCAL \(SET ROLE\)/,
  ],
  nestedComment: [
    unsafe('/* a /* b */ SET LOCAL */ SET ROLE univarse_app'),
    /SET without LOCAL \(SET ROLE\)/,
  ],
  afterLineComment: [
    unsafe('SELECT 1; -- SET LOCAL\nSET ROLE univarse_app'),
    /SET without LOCAL \(SET ROLE\)/,
  ],
  lowerCase: [unsafe('set role univarse_app'), /SET without LOCAL \(SET ROLE\)/],
  doBlock: [unsafe('DO $$ BEGIN SET ROLE univarse_app; END $$'), /SET without LOCAL \(SET ROLE\)/],
  executeString: [unsafe("DO $$ BEGIN EXECUTE 'LISTEN x'; END $$"), /LISTEN is session-scoped/],
  executeHexEscape: [
    unsafe(String.raw`DO $$ BEGIN EXECUTE E'\x53ET ROLE univarse_app'; END $$`),
    /SET without LOCAL \(SET ROLE\)/,
  ],
  quotedFunction: [unsafe('SELECT "pg_advisory_lock"(1)'), /pg_advisory_lock is a session-level/],
  qualifiedFunction: [
    unsafe('SELECT pg_catalog.pg_advisory_lock(1)'),
    /pg_advisory_lock is a session-level/,
  ],
  qualifiedSetConfig: [
    unsafe("SELECT pg_catalog.set_config('a.b', 'x', false)"),
    /third argument is false/,
  ],
  taggedTemplate: [
    `${HEAD}export async function f(p: PlatformClient, id: string) { await p.$executeRaw\`SET ROLE univarse_app; SELECT \${id}\`; }`,
    /\$executeRaw: SET without LOCAL \(SET ROLE\)/,
  ],
  queryRaw: [
    `${HEAD}export async function f(p: PlatformClient) { await p.$queryRaw\`DISCARD ALL\`; }`,
    /\$queryRaw: DISCARD/,
  ],
  prismaSqlFragment: [
    `${HEAD}export function f() { return PlatformModels.Prisma.sql\`SET ROLE univarse_app\`; }`,
    /Prisma\.sql: SET without LOCAL/,
  ],
  prismaRaw: [
    `${HEAD}export function f() { return PlatformModels.Prisma.raw('LISTEN x'); }`,
    /Prisma\.raw: LISTEN/,
  ],
};

/** What can't be established is refused. */
const REFUSED: Record<string, [string, RegExp]> = {
  unsafeVariable: [
    `${HEAD}export async function f(p: PlatformClient, sql: string) { await p.$executeRawUnsafe(sql); }`,
    /\$executeRawUnsafe with SQL that isn't a substitution-free literal/,
  ],
  unsafeTemplate: [
    `${HEAD}export async function f(p: PlatformClient, t: string) { await p.$executeRawUnsafe(\`SELECT \${t}\`); }`,
    /isn't a substitution-free literal/,
  ],
  rawCallNotSqlTemplate: [
    `${HEAD}export async function f(p: PlatformClient, q: PlatformModels.Prisma.Sql) { await p.$executeRaw(q); }`,
    /\$executeRaw\(…\) with something other than a Prisma\.sql template/,
  ],
  fragmentInterpolated: [
    `${HEAD}export async function f(p: PlatformClient) { const q = PlatformModels.Prisma.raw('SELECT 1'); await p.$executeRaw\`\${q}\`; }`,
    /\$executeRaw interpolates .*Sql.*, which isn't proven to be a bound parameter/,
  ],
  prismaRawVariable: [
    `${HEAD}export function f(s: string) { return PlatformModels.Prisma.raw(s); }`,
    /Prisma\.raw with SQL that isn't a substitution-free literal/,
  ],
  extracted: [
    `${HEAD}export async function f(p: PlatformClient) { const run = p.$executeRawUnsafe.bind(p); await run('SET ROLE x'); }`,
    /\$executeRawUnsafe referenced other than by its immediate call/,
  ],
  destructured: [
    `${HEAD}export async function f(p: PlatformClient) { const { $executeRawUnsafe } = p; void $executeRawUnsafe; }`,
    /\$executeRawUnsafe destructured from a database client/,
  ],
  computedKey: [
    `${HEAD}export async function f(p: PlatformClient) { await p['$executeRawUnsafe']('SET ROLE x'); }`,
    /computed access on a database client/,
  ],
  // The owner's indirect calls of 6297f22, with the real Prisma types (pg's are in the @univarse/db program below).
  constKey: [
    `${HEAD}export async function f(p: PlatformClient) { const method = '$executeRawUnsafe'; await p[method]('SET ROLE univarse_app'); }`,
    /computed access on a database client/,
  ],
  templateKey: [
    `${HEAD}export async function f(p: PlatformClient) { await p[\`$executeRawUnsafe\`]('SET ROLE univarse_app'); }`,
    /computed access on a database client/,
  ],
  stringVariableKey: [
    `${HEAD}export async function f(p: PlatformClient, m: string) { await (p as unknown as Record<string, (s: string) => Promise<unknown>>)[m]!('SET ROLE x'); void p[m as keyof PlatformClient]; }`,
    /computed access on a database client/,
  ],
  callThroughCall: [
    `${HEAD}export async function f(p: PlatformClient) { await p.$executeRawUnsafe.call(p, 'SET ROLE univarse_app'); }`,
    /\$executeRawUnsafe referenced other than by its immediate call/,
  ],
  renamedDestructure: [
    `${HEAD}export async function f(p: PlatformClient) { const { $executeRawUnsafe: run } = p; await run('SET ROLE x'); }`,
    /\$executeRawUnsafe destructured from a database client/,
  ],
  transactionClientComputed: [
    `import type { TenantTx } from '@univarse/db';
export async function f(tx: TenantTx) { const m = '$executeRawUnsafe' as const; await tx[m]('SET ROLE x'); }`,
    /computed access on a database client/,
  ],
  unionComputed: [
    `${HEAD}export function f(c: PlatformClient | Map<string, string>) { const k = '$executeRawUnsafe'; return c[k as never]; }`,
    /computed access on a database client/,
  ],
  // Inline dynamic SQL whose final command can't be established (owner's review of 6297f22).
  executeConcatenation: [
    unsafe("DO $$ BEGIN\n  EXECUTE 'SE' || 'T application_name TO DEFAULT';\nEND $$;"),
    /EXECUTE of anything but a string constant/,
  ],
  executeFormat: [
    unsafe("DO $$ BEGIN EXECUTE format('%s', 'SET ROLE x'); END $$"),
    /EXECUTE of anything but a string constant/,
  ],
  executeVariable: [
    unsafe("DO $$ DECLARE q text := 'SET ROLE x'; BEGIN EXECUTE q; END $$"),
    /EXECUTE of anything but a string constant/,
  ],
  executePrepared: [unsafe('EXECUTE q(1)'), /EXECUTE of anything but a string constant/],
  // PL/pgSQL block labels satisfy no exemption (owner's review of 40c80fe; each ran and changed session state).
  labelGrantExecute: [
    unsafe("DO $$ <<grant>> BEGIN\n  EXECUTE 'SE' || 'T application_name TO DEFAULT';\nEND; $$;"),
    /EXECUTE of anything but a string constant/,
  ],
  labelUpdateSet: [
    unsafe("DO $$ <<update>> BEGIN\n  SET application_name = 'pb4_after';\nEND; $$;"),
    /SET without LOCAL \(SET APPLICATION_NAME\)/,
  ],
  labelAlterReset: [
    unsafe('DO $$ <<alter>> BEGIN\n  RESET application_name;\nEND; $$;'),
    /RESET is session-scoped/,
  ],
  labelUpdateBeforeTarget: [
    unsafe('DO $$ <<update>> BEGIN t SET a = 1; END $$'),
    /SET without LOCAL/,
  ],
  ifUpdateThenSet: [
    unsafe('DO $$ BEGIN IF update THEN SET ROLE x; END IF; END $$'),
    /SET without LOCAL \(SET ROLE\)/,
  ],
  // A Prisma raw method held in a wrapper's member keeps its origin.
  prismaTypedWrapper: [
    `${HEAD}interface Raw { run: PlatformClient['$executeRawUnsafe'] }\nexport async function g(r: Raw) { await r.run('SET ROLE x'); }`,
    /\$executeRawUnsafe: SET without LOCAL \(SET ROLE\)/,
  ],
  unterminated: [unsafe("SELECT 'open"), /doesn't lex unambiguously: an unterminated string/],
  unicodeEscape: [unsafe("SELECT U&'\\0053ET'"), /doesn't lex unambiguously: a U&/],
};

/** Transaction-scoped and ordinary SQL: no violation. */
const ALLOWED: Record<string, string> = {
  setLocal: unsafe('SET LOCAL statement_timeout = 0'),
  setConfigTrue: `${HEAD}export async function f(p: PlatformClient, id: string) { await p.$executeRaw\`SELECT set_config('app.tenant_id', \${id}, true)\`; }`,
  setConfigTrueUpper: unsafe("SELECT set_config('app.tenant_id', 'x', TRUE)"),
  updateSet: unsafe("UPDATE outbox_event SET status = 'DONE' WHERE id = '1'"),
  upsertSet: unsafe(
    'INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = excluded.id',
  ),
  xactLock: unsafe('SELECT pg_advisory_xact_lock(1)'),
  xactLockShared: unsafe('SELECT pg_advisory_xact_lock_shared(1)'),
  forUpdate: unsafe('SELECT id FROM t FOR UPDATE SKIP LOCKED'),
  lookAlikeWords: unsafe('SELECT prepared_at, temp_value, listener, pg_temp_value FROM t'),
  executeConstant: unsafe("DO $$ DECLARE v int; BEGIN EXECUTE 'SELECT 1' INTO v USING 1; END $$"),
  grantExecute: unsafe('GRANT EXECUTE ON FUNCTION f() TO univarse_app'),
  grantListExecute: unsafe('GRANT SELECT, EXECUTE ON FUNCTION f() TO univarse_app'),
  revokeExecute: unsafe('REVOKE EXECUTE ON FUNCTION f() FROM univarse_app'),
  updateQualifiedAlias: unsafe('UPDATE ONLY public . t AS x SET a = 1'),
  updateQuotedAlias: unsafe('UPDATE "Order" o SET a = 1'),
  onDeleteSetNull: unsafe('CREATE TABLE t (a int REFERENCES u ON DELETE SET NULL)'),
  narrowedClient: `${HEAD}async function g(k: Pick<PlatformClient, 'tenant'>) { return k.tenant.count(); }\nexport async function f(p: PlatformClient) { return g(p); }`,
  boundParameters: `${HEAD}export async function f(p: PlatformClient, id: string, at: Date, ids: string[]) { await p.$queryRaw\`SELECT * FROM t WHERE id = \${id} AND at < \${at} AND id = ANY(\${ids})\`; }`,
};

const ALL = { ...FORMS, ...HIDDEN, ...REFUSED };
const path = (name: string) => `src/__session_sql_fixtures__/${name}.ts`;
let program: TS.Program;
beforeAll(() => {
  const files = {
    ...Object.fromEntries(Object.entries(ALL).map(([n, [t]]) => [path(n), t])),
    ...Object.fromEntries(Object.entries(ALLOWED).map(([n, t]) => [path(n), t])),
  };
  program = packageProgram('apps/api', files);
}, 120_000);
const check = (name: string) => {
  const sf = program
    .getSourceFiles()
    .find((s) => s.fileName.replace(/\\/g, '/').endsWith(`__session_sql_fixtures__/${name}.ts`));
  if (!sf) throw new Error(`fixture ${name} not in the program`);
  return analyzeSessionSql(program, sf);
};

describe('[PB4] no session-scoped SQL in production code', { timeout: 120_000 }, () => {
  it('[PB4] the current production code of the API, @univarse/db and @univarse/crypto passes', () => {
    const { violations, files } = sessionSqlScan();
    expect(violations).toEqual([]);
    // It really scanned them: the packages' sources, including the files with the known raw SQL.
    for (const f of [
      'packages/db/src/tenant.ts',
      'packages/crypto/src/platform-audit.ts',
      'apps/api/src/shared/outbox/outbox-worker.ts',
      'apps/api/src/shared/crypto/encrypted-columns.ts',
    ])
      expect(files).toContain(f);
    expect(files.filter((f) => f.startsWith('apps/api/src/')).length).toBeGreaterThan(50);
    expect(
      files.some((f) => /generated|testing|\.spec\.ts$|__session_sql_fixtures__/.test(f)),
    ).toBe(false);
  });

  it.each(Object.entries(FORMS))('[PB4] form %s fails', (name, [, problem]) => {
    const v = check(name);
    expect(v.length, v.join('\n')).toBeGreaterThan(0);
    expect(v.join('\n')).toMatch(problem);
  });

  it.each(Object.entries(HIDDEN))('[PB4] a hidden form is still found: %s', (name, [, problem]) => {
    expect(check(name).join('\n')).toMatch(problem);
  });

  it.each(Object.entries(REFUSED))(
    '[PB4] what can’t be established is refused: %s',
    (name, [, problem]) => {
      expect(check(name).join('\n')).toMatch(problem);
    },
  );

  it.each(Object.keys(ALLOWED))('[PB4] transaction-scoped or ordinary SQL passes: %s', (name) => {
    expect(check(name)).toEqual([]);
  });

  it("[PB4] pg's query(), with the real pg types: direct literals checked, indirect calls refused (owner's review of 6297f22)", () => {
    const PG = `import pg from 'pg';\n`;
    // [source, the problem it must report (null: none), and optionally how many violations exactly]
    const pgFixtures: Record<string, [string, RegExp | null, number?]> = {
      direct: [
        `${PG}export async function f(c: pg.Client) { await c.query('SET ROLE univarse_app'); }`,
        /pg query\(\): SET without LOCAL \(SET ROLE\)/,
      ],
      pool: [
        `${PG}export async function f(p: pg.Pool) { await p.query('LISTEN x'); }`,
        /pg query\(\): LISTEN is session-scoped/,
      ],
      poolClient: [
        `${PG}export async function f(c: pg.PoolClient) { await c.query('DISCARD ALL'); }`,
        /pg query\(\): DISCARD/,
      ],
      bound: [
        `${PG}export async function f(c: pg.Client) { const run = c.query.bind(c); await run('SET ROLE univarse_app'); }`,
        /query referenced other than by its immediate call/,
      ],
      destructured: [
        `${PG}export async function f(c: pg.Client) { const { query } = c; void query; }`,
        /query destructured from a database client/,
      ],
      computed: [
        `${PG}export async function f(c: pg.Client) { await c['query']('SET ROLE x'); }`,
        /computed access on a database client/,
      ],
      variableSql: [
        `${PG}export async function f(c: pg.Client, sql: string) { await c.query(sql); }`,
        /pg query\(\) with SQL that isn't a substitution-free literal/,
      ],
      allowed: [`${PG}export async function f(c: pg.Client) { await c.query('SELECT 1'); }`, null],
      // Owner's review of 40c80fe: a typed wrapper whose member is pg's own query type, and its caller.
      typedWrapper: [
        `import type { Client } from 'pg';\ninterface Db {\n  query: Client['query'];\n}\nasync function run(db: Db) {\n  await db.query('SET ROLE univarse_app');\n}\nexport async function use(client: Client) {\n  await run(client);\n}\n`,
        /pg query\(\): SET without LOCAL \(SET ROLE\)/,
        1, // the SET only: a member typed as pg's own query keeps its origin, so passing the client is no loss
      ],
      typedWrapperComputed: [
        `import type { Client } from 'pg';\ninterface Db { query: Client['query'] }\nexport async function f(db: Db) { await db['query']('SET ROLE x'); }`,
        /computed access on a database client/,
      ],
      typedParameter: [
        `${PG}async function run(q: pg.Client['query']) { await q('LISTEN x'); }\nexport async function use(c: pg.Client) { await run(c.query); }`,
        /pg query\(\): LISTEN is session-scoped/,
      ],
      structuralWrapper: [
        `${PG}interface Db { query(sql: string): Promise<unknown> }\nasync function run(db: Db) { await db.query('SET ROLE x'); }\nexport async function use(c: pg.Client) { await run(c); }`,
        /a database client passed as Db, which carries query without its SQL origin/,
      ],
      erasedToUnknown: [
        `${PG}export function f(c: pg.Client) { const x: unknown = c; return x; }`,
        /a database client assigned to unknown, which erases its SQL methods/,
      ],
      castThroughUnknown: [
        `${PG}interface Db { query(sql: string): Promise<unknown> }\nexport async function f(c: pg.Client) { await (c as unknown as Db).query('SET ROLE x'); }`,
        /a database client asserted as unknown, which erases its SQL methods/,
      ],
      stringIndexed: [
        `${PG}export function f(c: pg.Client) { const r: Record<string, unknown> = c; return r; }`,
        /a database client assigned to Record<string, unknown>/,
      ],
    };
    const dbProgram = packageProgram(
      'packages/db',
      Object.fromEntries(Object.entries(pgFixtures).map(([n, [t]]) => [path(n), t])),
    );
    for (const [name, [, problem, count]] of Object.entries(pgFixtures)) {
      const sf = dbProgram
        .getSourceFiles()
        .find((x) =>
          x.fileName.replace(/\\/g, '/').endsWith(`__session_sql_fixtures__/${name}.ts`),
        );
      if (!sf) throw new Error(`pg fixture ${name} not in the program`);
      const v = analyzeSessionSql(dbProgram, sf);
      if (problem === null) expect(v, name).toEqual([]);
      else expect(v.join('\n'), name).toMatch(problem);
      if (count !== undefined) expect(v, name).toHaveLength(count);
    }
  });

  it('[PB4] the SQL rules alone: SET LOCAL and UPDATE … SET pass; SET in a later statement still fails', () => {
    expect(sessionSqlProblems('SET LOCAL a = 1; UPDATE t SET a = 1')).toEqual({ problems: [] });
    expect(sessionSqlProblems('UPDATE t SET a = 1; SET a = 1')).toMatchObject({
      problems: [expect.stringMatching(/SET without LOCAL/)],
    });
  });
});
