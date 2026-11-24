// Spec 0039 PR B: the `shards` job's entry point (`node dist/shards-main.js <command> …`), run by the owner's
// `pnpm stack:shards` from the deployed migrate image with the migrate job's settings. It prints progress lines, then
// one JSON line the host reads: `{ ok: true, … }`, or `{ ok: false, refused }` (exit 3). Exit 2 for a usage error,
// 1 for a failure. Nothing printed carries a URL or a secret.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { rlsCheck } from '@univarse/db-ops';
import { drill, list, migrateShard, readyOne, retireShard, ShardRefused, type OpsDeps } from './shard-ops.js';

export const SHARDS_USAGE =
  'usage: shards ready [--count <1-10>] | migrate <shard> [--applied <migration> | --rolled-back <migration>] | retire <shard> --confirm <shard> [--backup-after <ISO time>] | drill | list';

export type ShardsCommand =
  | { readonly kind: 'ready'; readonly count: number }
  | { readonly kind: 'migrate'; readonly shard: string; readonly resolve?: { as: 'applied' | 'rolled-back'; migration: string } }
  | { readonly kind: 'retire'; readonly shard: string; readonly backupAfter: Date | null }
  | { readonly kind: 'drill' }
  | { readonly kind: 'list' };

const SHARD_NAME = /^(pool-[0-9]{2}|t-[a-z0-9]{12})$/;

/** The command, or null when the arguments aren't exactly one of the forms above. Pure. */
export function parseShardsArgs(argv: readonly string[]): ShardsCommand | null {
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case 'ready': {
      if (rest.length === 0) return { kind: 'ready', count: 1 };
      const n = Number(flag('count'));
      if (rest.length !== 2 || !Number.isInteger(n) || n < 1 || n > 10) return null;
      return { kind: 'ready', count: n };
    }
    case 'migrate': {
      const [shard, ...more] = rest;
      if (!shard || !SHARD_NAME.test(shard)) return null;
      if (more.length === 0) return { kind: 'migrate', shard };
      const [opt, migration, ...extra] = more;
      if (extra.length || !migration || (opt !== '--applied' && opt !== '--rolled-back')) return null;
      return { kind: 'migrate', shard, resolve: { as: opt === '--applied' ? 'applied' : 'rolled-back', migration } };
    }
    case 'retire': {
      const [shard, ...more] = rest;
      if (!shard || !SHARD_NAME.test(shard) || flag('confirm') !== shard) return null;
      const after = flag('backup-after');
      const allowed = after === undefined ? 2 : 4;
      if (more.length !== allowed) return null;
      const backupAfter = after === undefined ? null : new Date(after);
      if (backupAfter && Number.isNaN(backupAfter.getTime())) return null;
      return { kind: 'retire', shard, backupAfter };
    }
    case 'drill':
    case 'list':
      return rest.length === 0 ? { kind: cmd } : null;
    default:
      return null;
  }
}

const need = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

/** The job's dependencies from its environment: the superuser creates and drops; the migrator migrates. */
export function realOpsDeps(env: NodeJS.ProcessEnv, log: (l: string) => void): OpsDeps {
  const require = createRequire(import.meta.url);
  const superuserTo = (database: string) => {
    const u = new URL(need(env, 'BOOTSTRAP_SUPERUSER_URL'));
    u.pathname = `/${database}`;
    return u.toString();
  };
  const open = async (database: string) => {
    const c = new pg.Client({ connectionString: superuserTo(database) });
    await c.connect();
    return c;
  };
  return {
    env,
    platformMigratorUrl: need(env, 'PLATFORM_MIGRATOR_URL'),
    admin: () => open('postgres'),
    connectAs: open,
    prismaCli: require.resolve('prisma/build/index.js'),
    tenantConfig: fileURLToPath(new URL('../prisma/tenant.config.mjs', import.meta.url)),
    rlsCheck,
    log,
  };
}

const out = (v: unknown) => console.log(JSON.stringify(v));

export async function main(argv: readonly string[], deps: OpsDeps): Promise<number> {
  const cmd = parseShardsArgs(argv);
  if (!cmd) {
    console.error(SHARDS_USAGE);
    return 2;
  }
  try {
    switch (cmd.kind) {
      case 'ready': {
        const made = [];
        for (let i = 0; i < cmd.count; i++) made.push(await readyOne(deps));
        out({ ok: true, made });
        return 0;
      }
      case 'migrate': {
        const r = await migrateShard(deps, cmd.shard, cmd.resolve);
        out({ ok: true, migrated: r.ok, code: r.code });
        return 0;
      }
      case 'retire':
        out({ ok: true, ...(await retireShard(deps, cmd.shard, cmd.backupAfter)) });
        return 0;
      case 'drill':
        out({ ok: true, ...(await drill(deps)) });
        return 0;
      case 'list':
        out({ ok: true, ...(await list(deps)) });
        return 0;
    }
  } catch (e) {
    if (e instanceof ShardRefused) {
      out({ ok: false, refused: e.why });
      return 3;
    }
    console.error((e as Error).message.split('\n')[0]?.slice(0, 200));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), realOpsDeps(process.env, (l) => console.log(l)));
}
