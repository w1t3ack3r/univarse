// Spec 0020 PR B1: the owner's backup commands.
//   pnpm stack:backup                          one set (D2, D3, D5), pruned at its end (D6)
//   pnpm stack:backup wal                      ship the WAL staged since the last run (B-2)
//   pnpm stack:backup keygen --out <path>      once, offline: the backup key pair (D5, B-5)
//   pnpm stack:backup destination <path>       where sets go (default ~/.univarse/backups); D7's rule applies
// Exit 0 only on success. Nothing printed is a secret.
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRIMARY } from '../keys.js';
import { establishAuthority } from '../ledger/ledger.js';
import { RELEASES } from '../config.js';
import { acquireRegistryLock } from '../release.js';
import { takeBackup } from './backup.js';
import { loadSettings, saveSettings } from './config.js';
import { externalRuleProblem } from './external.js';
import { keygen } from './keygen.js';
import { realBackupDeps } from './real.js';
import { realWalDeps, shipWal } from './wal.js';

const USAGE = 'usage: pnpm stack:backup [wal | keygen --out <path> | destination <absolute path>]';
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

export async function main(argv: readonly string[]): Promise<{ ok: boolean; lines: string[] }> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return takeBackup(realBackupDeps());
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
  let r: { ok: boolean; lines: string[] };
  try {
    r = await main(process.argv.slice(2));
  } catch (e) {
    r = { ok: false, lines: [(e as Error).message] };
  }
  for (const l of r.lines) (r.ok ? console.log : console.error)(`[stack:backup] ${l}`);
  process.exit(r.ok ? 0 : 1);
}
