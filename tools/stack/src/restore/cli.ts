// Spec 0020 B2b: the owner's restore commands.
//   pnpm stack:restore-rehearsal --key <path> [--set <id>] [--to <ISO time>]   a set restored into its own project,
//                                                                               checked, and torn down (D9, B2-6)
//   pnpm stack:drill --key <path>                                               B-12's shred drill, as one command (B2-11)
//   pnpm stack:restore <set> --key <path> --confirm "replace the stack's data" [--to <ISO time>]
//                                                                               a real disaster's restore (B2-12)
// The key file's passphrase comes from UNIVARSE_BACKUP_KEY_PASSPHRASE, never an argument; neither is ever printed.
// The rehearsal and the drill write their record to docs/ops/drills/ for the owner to commit. Exit 0 only on success.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restrictDirToOwner, writeOwnerOnly } from '../../../../packages/db/scripts/pgbouncer-config.js';
import { takeBackup } from '../backup/backup.js';
import { realBackupDeps } from '../backup/real.js';
import { REPO, STACK_DIR } from '../config.js';
import { docker } from '../docker.js';
import { realProtocolDeps } from '../keys.js';
import { composeRunner, deployedImages } from '../ledger/job.js';
import { destroy } from '../ledger/protocol.js';
import { printer } from '../print.js';
import { loadSecrets, secretValues } from '../secrets.js';
import { drill } from './drill.js';
import { restore, type RestoreRecord, type RestoreRequest, type RestoreResult } from './engine.js';
import { realRestoreDeps } from './real.js';
import { afterRestore, CONFIRMATION, prepareRealRestore } from './real-restore.js';
import { recordMarkdown, secretProblems, type DrillFacts } from './record.js';
import { STACK_DATA } from './target.js';

const USAGE = [
  'usage: pnpm stack:restore-rehearsal --key <path> [--set <id>] [--to <ISO time>]',
  '       pnpm stack:drill --key <path>',
  `       pnpm stack:restore <set> --key <path> --confirm "${CONFIRMATION}" [--to <ISO time>]`,
  '       (the key file\'s passphrase in UNIVARSE_BACKUP_KEY_PASSPHRASE)',
].join('\n');
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

function flags(rest: readonly string[], allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]?.replace(/^--/, '') ?? '';
    const value = rest[i + 1];
    if (!rest[i]?.startsWith('--') || !allowed.includes(name) || value === undefined || name in out) throw new Error(USAGE);
    out[name] = value;
  }
  return out;
}

function when(s: string | undefined): Date | undefined {
  if (s === undefined) return undefined;
  const d = new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || Number.isNaN(d.getTime())) throw new Error(`--to takes an ISO time, such as 2026-10-26T02:30:00Z\n${USAGE}`);
  return d;
}

const tools = () => spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();

/** B2-11: the record, scanned (BK9), written for the owner to commit. */
function writeRecord(r: RestoreRecord, kind: 'restore-and-shred' | 'restore-rehearsal', drillFacts?: DrillFacts): string {
  const date = new Date().toISOString().slice(0, 10);
  const md = recordMarkdown(r, { date, tools: tools(), ...(drillFacts ? { drill: drillFacts } : {}) });
  // The stack's own secrets, which the set's are (a fresh machine has none yet: the other patterns still apply).
  let secrets: string[];
  try {
    secrets = secretValues(loadSecrets());
  } catch {
    secrets = [];
  }
  const found = secretProblems(md, secrets);
  if (found.length) throw new Error(`the record was not written: it would hold ${found.join(', ')} (BK9)`);
  const dir = join(REPO, 'docs', 'ops', 'drills');
  mkdirSync(dir, { recursive: true });
  return writeNew(dir, `${date}-${kind}`, md);
}

/**
 * `<dir>/<base>.md`, or `<base>-2.md` and on when that exists. Each is created exclusively ('wx'): never checked first,
 * and an existing record is never overwritten.
 */
export function writeNew(dir: string, base: string, text: string): string {
  for (let n = 1; n < 100; n++) {
    const file = join(dir, n === 1 ? `${base}.md` : `${base}-${String(n)}.md`);
    try {
      writeFileSync(file, text, { flag: 'wx' });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`the record was not written: 99 records named ${base} already in ${dir}`);
}

function passphrase(): string {
  const p = process.env.UNIVARSE_BACKUP_KEY_PASSPHRASE;
  if (!p) throw new Error(`set UNIVARSE_BACKUP_KEY_PASSPHRASE to the backup key's passphrase first (it is never an argument)\n${USAGE}`);
  return p;
}

async function rehearse(req: RestoreRequest, keyFile: string, log: (l: string) => void): Promise<RestoreResult> {
  return restore(req, realRestoreDeps(req, { keyFile, passphrase: passphrase(), log }));
}

export async function main(command: string | undefined, argv: readonly string[], log: (l: string) => void): Promise<{ ok: boolean; lines: string[] }> {
  if (command === 'rehearsal') {
    const f = flags(argv, ['key', 'set', 'to']);
    if (!f.key) throw new Error(USAGE);
    const to = when(f.to);
    const r = await rehearse({ mode: 'rehearsal', ...(f.set ? { setId: f.set } : {}), ...(to ? { to } : {}) }, here(f.key), log);
    if (!r.ok || !r.record) return { ok: false, lines: [] };
    return { ok: true, lines: [`the record: ${writeRecord(r.record, 'restore-rehearsal')} (commit it)`] };
  }
  if (command === 'drill') {
    const f = flags(argv, ['key']);
    if (!f.key) throw new Error(USAGE);
    const keyFile = here(f.key);
    passphrase(); // before anything is created: a missing passphrase stops it at once
    const images = deployedImages();
    const p = printer(log);
    const d = await drill(new Date(), {
      log,
      createTenant: (slug) => {
        const r = composeRunner(images)(['drill-tenant', 'create', slug]);
        const out = (() => {
          try {
            return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '') as { tenantId?: string; keyVersion?: number; values?: number };
          } catch {
            return null;
          }
        })();
        if (r.status !== 0 || !out?.tenantId) return { ok: false, lines: [`the keys job's drill-tenant create failed: ${r.stderr.trim().split('\n').at(-1) ?? `exit ${String(r.status)}`}`] };
        return { ok: true, tenantId: out.tenantId, keyVersion: out.keyVersion ?? 0, values: out.values ?? 0 };
      },
      backup: async () => {
        const b = p.unprinted(await takeBackup({ ...realBackupDeps(), log: p.log }));
        return b.ok && b.setId ? { ok: true, setId: b.setId } : { ok: false, lines: b.lines };
      },
      destroy: async (slug) => {
        const r = await destroy(realProtocolDeps(images), { slug });
        for (const l of r.lines) log(`keys: ${l}`);
        return r.ok && r.op ? { ok: true, op: r.op } : { ok: false, lines: ['the destruction was not accepted (above)'] };
      },
      rehearse: (setId, slug) => rehearse({ mode: 'rehearsal', setId, drill: slug }, keyFile, log),
    });
    if (!d.ok || !d.result?.record || !d.facts) return { ok: false, lines: d.lines.slice(-1) };
    return { ok: true, lines: [d.lines.at(-1) ?? '', `the record: ${writeRecord(d.result.record, 'restore-and-shred', d.facts)} (commit it)`] };
  }
  if (command === 'restore') {
    const [setId, ...rest] = argv;
    const f = flags(rest, ['key', 'confirm', 'to']);
    if (!setId || setId.startsWith('--') || !f.key) throw new Error(USAGE);
    if (f.confirm !== CONFIRMATION) return { ok: false, lines: [`a real restore replaces the stack's data: give --confirm "${CONFIRMATION}", word for word`] };
    const to = when(f.to);
    const req: RestoreRequest = { mode: 'restore', setId, ...(to ? { to } : {}) };
    const r = await restore(
      req,
      realRestoreDeps(req, {
        keyFile: here(f.key),
        passphrase: passphrase(),
        log,
        data: STACK_DATA,
        prepare: async (set, data) =>
          prepareRealRestore(data, await set.files('stack.tar'), new Date(), {
            run: docker,
            stackRunning: () => docker(['ps', '-q', '--filter', 'label=com.docker.compose.project=univarse-stack'], { allowFail: true }).stdout.trim() !== '',
            replaceStackDir: (stamp, parts) => {
              if (existsSync(STACK_DIR)) renameSync(STACK_DIR, `${STACK_DIR}.before-restore-${stamp}`);
              mkdirSync(STACK_DIR, { recursive: true });
              restrictDirToOwner(STACK_DIR);
              for (const part of parts) writeOwnerOnly(join(STACK_DIR, ...part.name.split('/')), part.data.toString('utf8'));
            },
            log,
          }),
      }),
    );
    return r.ok && r.record ? { ok: true, lines: afterRestore(r.record.release) } : { ok: false, lines: [] };
  }
  throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...argv] = process.argv.slice(2);
  const prefix = `[stack:${command === 'rehearsal' ? 'restore-rehearsal' : command ?? 'restore'}]`;
  const log = (l: string) => {
    console.log(`${prefix} ${l}`);
  };
  let r: { ok: boolean; lines: string[] };
  try {
    r = await main(command, argv, log);
  } catch (e) {
    r = { ok: false, lines: [(e as Error).message] };
  }
  for (const l of r.lines) (r.ok ? console.log : console.error)(`${prefix} ${l}`);
  process.exit(r.ok ? 0 : 1);
}
