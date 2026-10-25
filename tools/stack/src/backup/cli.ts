// Spec 0020 PR B1 and B2a: the owner's backup commands.
//   pnpm stack:backup                          one set (D2, D3, D5), pruned at its end (D6)
//   pnpm stack:backup wal                      ship the WAL staged since the last run (B-2)
//   pnpm stack:backup status                   the newest set, the erasure boundary, WAL, the schedule (B2-2)
//   pnpm stack:backup schedule --at HH:MM [--apply] | --remove   the two scheduled tasks (B2-4)
//   pnpm stack:backup keygen --out <path>      once, offline: the backup key pair (D5, B-5)
//   pnpm stack:backup destination <path>       where sets go (default ~/.univarse/backups); D7's rule applies
// `--scheduled` (the scheduled tasks give it): the run's lines go to its log too, and a backup waits for the registry
// lock (B2-4). Exit 0 only on success. Nothing printed is a secret.
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRIMARY } from '../keys.js';
import { establishAuthority } from '../ledger/ledger.js';
import { RELEASES } from '../config.js';
import { printer } from '../print.js';
import { acquireRegistryLock } from '../release.js';
import { takeBackup } from './backup.js';
import { loadSettings, saveSettings } from './config.js';
import { externalRuleProblem } from './external.js';
import { keygen } from './keygen.js';
import { realBackupDeps } from './real.js';
import { registryLockFor, scheduledLog } from './scheduled.js';
import { realStatusInputs, schedule, scheduleInputs } from './status-deps.js';
import { parseAt } from './schedule.js';
import { statusReport } from './status.js';
import { realWalDeps, shipWal } from './wal.js';

const USAGE = 'usage: pnpm stack:backup [wal | status | schedule --at <HH:MM> [--apply] | schedule --remove | keygen --out <path> | destination <absolute path>] [--scheduled]';
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

const echo = (l: string) => {
  console.log(`[stack:backup] ${l}`);
};

export async function main(argv: readonly string[], opts: { scheduled?: boolean; log?: (l: string) => void } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const [cmd, ...rest] = argv;
  const print = opts.log ?? echo;
  if (cmd === undefined) {
    const p = printer(print);
    const deps = realBackupDeps();
    // B2-4: a scheduled backup waits for a deploy or a release to finish, rather than losing the day's set.
    return p.unprinted(await takeBackup({ ...deps, lockRegistry: registryLockFor((h) => deps.lockRegistry(h), opts.scheduled ?? false, { log: p.log }), log: p.log }));
  }
  if (cmd === 'status') {
    if (rest.length) return { ok: false, lines: [USAGE] };
    const r = statusReport(realStatusInputs());
    return { ok: r.ok, lines: r.lines };
  }
  if (cmd === 'schedule') {
    if (rest.length === 1 && rest[0] === '--remove') return schedule('remove', scheduleInputs('00:00'));
    const [flag, at, ...more] = rest;
    const mode = more.length === 0 ? 'print' : more.length === 1 && more[0] === '--apply' ? 'apply' : null;
    if (flag !== '--at' || !parseAt(at) || !mode) return { ok: false, lines: [USAGE] };
    return schedule(mode, scheduleInputs(at ?? ''));
  }
  if (cmd === 'keygen') {
    if (rest.length !== 2 || rest[0] !== '--out') return { ok: false, lines: [USAGE] };
    return keygen(here(rest[1] ?? ''));
  }
  if (cmd === 'destination') {
    const path = rest[0];
    if (rest.length !== 1 || !path || !isAbsolute(path)) return { ok: false, lines: [USAGE] };
    const a = establishAuthority(PRIMARY);
    if (!a.ok) return { ok: false, lines: ["the shred ledger's destinations can't be read:", ...a.problems] };
    const rule = externalRuleProblem(path, PRIMARY.path, a.destinations.map((d) => d.path));
    if (rule) return { ok: false, lines: [rule] };
    saveSettings({ destination: path });
    return { ok: true, lines: [`backups go to ${path}`] };
  }
  if (cmd === 'wal' && rest.length === 0) {
    const deps = realBackupDeps();
    let lock: { release(): void };
    try {
      lock = acquireRegistryLock(RELEASES, 'backup wal');
    } catch (e) {
      // A deploy, release or backup holds it: the next run ships what is staged (status reports its age).
      return { ok: true, lines: [`nothing shipped now: ${(e as Error).message}`] };
    }
    try {
      const key = deps.publicKey();
      if (!key) return { ok: false, lines: ['no backup public key: run `pnpm stack:backup keygen --out <offline path>` first'] };
      const destination = loadSettings().destination;
      deps.prepareDestination(destination);
      return { ok: true, lines: (await shipWal(destination, key, realWalDeps())).lines };
    } finally {
      lock.release();
    }
  }
  return { ok: false, lines: [USAGE] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const scheduled = argv.includes('--scheduled');
  // B2-4: a scheduled run's lines go to its dated log too, as they're printed.
  const toLog = scheduled ? scheduledLog() : null;
  const log = (l: string) => {
    echo(l);
    toLog?.(l);
  };
  let r: { ok: boolean; lines: string[] };
  try {
    r = await main(argv.filter((a) => a !== '--scheduled'), { scheduled, log });
  } catch (e) {
    r = { ok: false, lines: [(e as Error).message] };
  }
  for (const l of r.lines) {
    (r.ok ? console.log : console.error)(`[stack:backup] ${l}`);
    toLog?.(`${r.ok ? '' : 'ERROR '}${l}`);
  }
  toLog?.(`exit ${r.ok ? '0' : '1'}`);
  process.exit(r.ok ? 0 : 1);
}
