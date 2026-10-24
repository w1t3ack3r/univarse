// Spec 0020 D7, D8, BK16: the only way keys are destroyed in the stack.
//   pnpm stack:keys destroy <tenant> [--version <n>]       the protocol (D7): accepted only once durable everywhere
//   pnpm stack:keys recover                                D8 (every deploy runs it too)
//   pnpm stack:keys ledger init [--destination <path>]…    once, for a stack that has never had a ledger
//   pnpm stack:keys ledger add-destination <path>
//   pnpm stack:keys ledger rebuild-destination <path> [--from <path>]
//   pnpm stack:keys ledger remove-destination <path> --reason "…"
//   pnpm stack:keys ledger abandon <op> --reason "…" --confirm "its outcome is not established"
//                                                          a pending op recovery can't complete: a recorded waiver
//   pnpm stack:keys ledger waive --reason "…" --confirm "destroyed tenants may return" --destination <path>… [--from <path>]…
//                                                          D8's waiver (A3): only when no configured destination can be read
//   pnpm stack:keys ledger status
// The database step runs as the `keys` job from the deployed API image (ledger/job.ts). Exit 0 only on success.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Destination } from './ledger/chain.js';
import { addDestination, init, rebuildDestination, removeDestination, status } from './ledger/commands.js';
import { deployedImages, keysJob } from './ledger/job.js';
import { acquireLedgerLock } from './ledger/lock.js';
import { abandon, destroy, recover, type ProtocolDeps, type Result } from './ledger/protocol.js';
import { waive } from './ledger/waiver.js';
import { loadSettings } from './backup/config.js';
import { externalRuleProblem } from './backup/external.js';

/** D7: the primary destination, outside the stack failure domain. */
export const LEDGER_DIR = process.env.UNIVARSE_LEDGER_DIR ?? join(homedir(), '.univarse', 'ledger');
export const PRIMARY: Destination = { id: 'primary', path: LEDGER_DIR };

/** The bucket copy's own record of how far it got, per ledger (a dot-file the ledger's copy checks ignore). */
export function bucketRecord(dir = LEDGER_DIR): NonNullable<ProtocolDeps['bucket']> {
  const file = join(dir, '.bucket-copied.json');
  const load = (): Record<string, number> => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>) : {});
  return {
    copied: (id) => load()[id] ?? 0,
    mark: (id, seq) => writeFileSync(file, `${JSON.stringify({ ...load(), [id]: seq })}\n`, { mode: 0o600 }),
  };
}

/** The real dependencies; `images` are the API image (and the rest compose needs) the keys job runs. */
export function realProtocolDeps(images: Readonly<Record<string, string>>, opts: { lockWaitMs?: number } = {}): ProtocolDeps {
  return {
    primary: PRIMARY,
    db: keysJob(images),
    lock: (holder) => acquireLedgerLock(LEDGER_DIR, holder, opts.lockWaitMs === undefined ? {} : { waitMs: opts.lockWaitMs }),
    log: (line) => console.log(line),
    bucket: bucketRecord(),
  };
}

const USAGE = [
  'usage: pnpm stack:keys destroy <tenant> [--version <n>]',
  '       pnpm stack:keys recover',
  '       pnpm stack:keys ledger <init [--destination <path>]… | add-destination <path> | rebuild-destination <path> [--from <path>] | remove-destination <path> --reason "…" | abandon <op> --reason "…" --confirm "its outcome is not established" | waive --reason "…" --confirm "destroyed tenants may return" --destination <path>… [--from <path>]… | status>',
].join('\n');

/** `--name value` pairs; `repeat` names the one flag that may be given more than once. */
function parse(rest: readonly string[], allowed: readonly string[], repeat?: string | readonly string[]): { values: Record<string, string>; repeated: string[]; lists: Record<string, string[]> } {
  const repeats = repeat === undefined ? [] : typeof repeat === 'string' ? [repeat] : repeat;
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = Object.fromEntries(repeats.map((r) => [r, []]));
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, '') ?? '';
    const value = rest[i + 1];
    if (!rest[i]?.startsWith('--') || !allowed.includes(name) || value === undefined) throw new Error(USAGE);
    if (repeats.includes(name)) lists[name]?.push(value);
    else if (name in values) throw new Error(USAGE);
    else values[name] = value;
  }
  return { values, repeated: lists[repeats[0] ?? ''] ?? [], lists };
}

const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

export async function main(argv: readonly string[]): Promise<Result> {
  const [command, ...rest] = argv;
  const deps = () => realProtocolDeps(deployedImages());
  switch (command) {
    case 'destroy': {
      const [slug, ...flags] = rest;
      const { values } = parse(flags, ['version']);
      if (!slug || (values.version !== undefined && !/^[1-9]\d*$/.test(values.version))) throw new Error(USAGE);
      return destroy(deps(), { slug, ...(values.version === undefined ? {} : { version: Number(values.version) }) });
    }
    case 'recover':
      if (rest.length) throw new Error(USAGE);
      return recover(deps());
    case 'ledger': {
      const [sub, ...more] = rest;
      switch (sub) {
        case 'init': {
          const { repeated } = parse(more, ['destination'], 'destination');
          return init(deps(), repeated.map(here));
        }
        case 'add-destination':
          if (!more[0] || more.length !== 1) throw new Error(USAGE);
          return addDestination(deps(), here(more[0]));
        case 'rebuild-destination': {
          const [path, ...flags] = more;
          const { values } = parse(flags, ['from']);
          if (!path) throw new Error(USAGE);
          return rebuildDestination(deps(), here(path), values.from === undefined ? undefined : here(values.from));
        }
        case 'remove-destination': {
          const [path, ...flags] = more;
          const { values } = parse(flags, ['reason']);
          if (!path || !values.reason) throw new Error(USAGE);
          return removeDestination(deps(), here(path), values.reason);
        }
        case 'abandon': {
          const [op, ...flags] = more;
          const { values } = parse(flags, ['reason', 'confirm']);
          if (!op || !values.reason) throw new Error(USAGE);
          return abandon(deps(), op, values.reason, values.confirm ?? '');
        }
        case 'waive': {
          const { values, lists } = parse(more, ['reason', 'confirm', 'destination', 'from'], ['destination', 'from']);
          return waive(deps(), {
            reason: values.reason ?? '',
            confirm: values.confirm ?? '',
            destinations: (lists.destination ?? []).map(here),
            from: (lists.from ?? []).map(here),
            // D7: with the backups on an external drive, the new generation needs a destination on it too.
            destinationRule: (paths) => externalRuleProblem(loadSettings().destination, PRIMARY.path, paths),
          });
        }
        case 'status':
          return status({ ...realProtocolDeps({}), primary: PRIMARY });
        default:
          throw new Error(USAGE);
      }
    }
    default:
      throw new Error(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result: Result;
  try {
    result = await main(process.argv.slice(2));
  } catch (e) {
    result = { ok: false, lines: [(e as Error).message] };
  }
  for (const line of result.lines) (result.ok ? console.log : console.error)(`[stack:keys] ${line}`);
  process.exit(result.ok ? 0 : 1);
}
