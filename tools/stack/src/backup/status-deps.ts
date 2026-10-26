// Spec 0020 B2-2, B2-4: the real inputs `status` reads, and the schedule's registration. Every reader catches its own
// failure and reports why, so one unreadable source (Docker stopped, the external drive out) never hides the rest.
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../config.js';
import { docker, type Runner } from '../docker.js';
import { establishAuthority } from '../ledger/ledger.js';
import { waivedSince } from '../ledger/waiver.js';
import { PRIMARY } from '../keys.js';
import { loadSettings } from './config.js';
import { externalRuleProblem } from './external.js';
import { cronLines, parseTaskInfo, taskPath, TASKS, taskXml, type ScheduleInputs, type TaskKind } from './schedule.js';
import { listSets, WAL } from './set.js';
import type { Dated, StatusInputs, TaskState } from './status.js';
import { stagedFiles } from './wal.js';
import { SEALED_LINE, tokenStates, vaultState } from '../vault.js';
import { lastCheckout } from './checkout.js';

const why = (e: unknown) => ({ problem: (e as Error).message });

/** Every shipped WAL file, with its time at the destination (when it was shipped). */
export function shippedWal(destination: string): Dated[] {
  const root = join(destination, WAL);
  let timelines: string[];
  try {
    timelines = readdirSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return timelines.flatMap((t) =>
    readdirSync(join(root, t))
      .filter((n) => n.endsWith('.gz.seal'))
      .map((n) => ({ name: n.replace(/\.gz\.seal$/, ''), at: statSync(join(root, t, n)).mtime })),
  );
}

/** One process: its exit status and output. Injected, so the PowerShell and schtasks calls are tested. */
export type Exec = (cmd: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
export const exec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** The task's last run, through PowerShell's ScheduledTasks module: its result is a number in any Windows language. */
export function taskState(kind: TaskKind, run: Exec = exec): TaskState {
  const name = TASKS[kind];
  const script = [
    `$t = Get-ScheduledTask -TaskPath '\\UniVarse\\' -TaskName '${name}' -ErrorAction SilentlyContinue`,
    "if ($t) { $i = $t | Get-ScheduledTaskInfo; @{ run = $i.LastRunTime.ToUniversalTime().ToString('o'); result = $i.LastTaskResult } | ConvertTo-Json -Compress } else { 'null' }",
  ].join('; ');
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (r.status !== 0) throw new Error(`PowerShell exited ${String(r.status)} reading task ${name}`);
  return parseTaskInfo(name, r.stdout);
}

export function realStatusInputs(now = new Date(), opts: { run?: Runner; exec?: Exec; platform?: NodeJS.Platform } = {}): StatusInputs {
  const platform = opts.platform ?? process.platform;
  const destination = loadSettings().destination;
  const read = <T>(f: () => T): T | { problem: string } => {
    try {
      return f();
    } catch (e) {
      return why(e);
    }
  };
  const authority = establishAuthority(PRIMARY);
  return {
    now,
    destination,
    sets: read(() => listSets(destination)),
    shipped: read(() => shippedWal(destination)),
    staged: read(() => stagedFiles(opts.run ?? docker)),
    schedule: platform === 'win32' ? read(() => (['daily', 'wal'] as const).map((k) => taskState(k, opts.exec))) : null,
    externalRule: authority.ok ? externalRuleProblem(destination, PRIMARY.path, authority.destinations.map((d) => d.path)) : null,
    waived: authority.ok ? waivedSince(authority.entries) : { problem: authority.problems.join('; ') },
    // Spec 0023 T5: looked up with the root token, the tokens on stdin; a sealed Vault is a problem in its own words.
    tokens: read(() => (vaultState(opts.run ?? docker) === 'sealed' ? { problem: SEALED_LINE } : tokenStates(opts.run ?? docker))),
    checkout: read(() => lastCheckout()),
  };
}

/** The schedule's inputs from this process: the node running it, pnpm's own script, the owner, this checkout. */
export function scheduleInputs(at: string, now = new Date(), env: NodeJS.ProcessEnv = process.env): ScheduleInputs {
  const pnpm = env.npm_execpath;
  if (!pnpm || !/pnpm/i.test(pnpm)) throw new Error('run this through pnpm (`pnpm stack:backup schedule …`): the tasks record pnpm\'s own path');
  // Windows: DOMAIN\user, which the task's principal names. Elsewhere only crontab lines are printed.
  const user = env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${env.USERNAME}` : (env.USERNAME ?? env.USER ?? userInfo().username);
  const p = (n: number) => String(n).padStart(2, '0');
  const startDate = `${String(now.getFullYear())}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return { at, startDate, user, node: process.execPath, pnpm, repo: REPO };
}

/**
 * B2-4: prints the two tasks' XML (and nothing changes), or with `apply` registers them, or with `remove` deletes them.
 * Outside Windows it prints crontab lines and registers nothing.
 */
export function schedule(mode: 'print' | 'apply' | 'remove', i: ScheduleInputs, opts: { platform?: NodeJS.Platform; exec?: Exec; tmp?: string } = {}): { ok: boolean; lines: string[] } {
  const platform = opts.platform ?? process.platform;
  const run = opts.exec ?? exec;
  if (platform !== 'win32') {
    if (mode !== 'print') return { ok: false, lines: ['scheduled tasks are registered on Windows only; add these lines with `crontab -e` yourself:', ...cronLines(i)] };
    return { ok: true, lines: ['not on Windows: nothing is registered. The equivalent crontab lines:', ...cronLines(i)] };
  }
  const kinds = ['daily', 'wal'] as const;
  if (mode === 'remove') {
    const lines: string[] = [];
    let ok = true;
    for (const k of kinds) {
      const r = run('schtasks.exe', ['/Delete', '/TN', taskPath(k), '/F']);
      if (r.status === 0) lines.push(`removed ${taskPath(k)}`);
      else {
        ok = false;
        lines.push(`${taskPath(k)} was not removed (schtasks exited ${String(r.status)}): ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
      }
    }
    return { ok, lines };
  }
  const defs = kinds.map((k) => ({ kind: k, xml: taskXml(k, i) }));
  if (mode === 'print')
    return {
      ok: true,
      lines: [
        ...defs.flatMap((d) => [`── ${taskPath(d.kind)} ──`, ...d.xml.trimEnd().split('\r\n')]),
        `nothing is registered: read the above, then run again with --apply (both run as ${i.user}, only when logged on)`,
      ],
    };
  const lines: string[] = [];
  for (const d of defs) {
    // schtasks reads the file as UTF-16, which the XML declares: written with its byte-order mark, then removed.
    const file = join(opts.tmp ?? tmpdir(), `univarse-${TASKS[d.kind]}-${String(process.pid)}.xml`);
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(d.xml, 'utf16le')]), { mode: 0o600 });
    try {
      const r = run('schtasks.exe', ['/Create', '/TN', taskPath(d.kind), '/XML', file, '/F']);
      if (r.status !== 0) return { ok: false, lines: [...lines, `${taskPath(d.kind)} was not registered (schtasks exited ${String(r.status)}): ${r.stderr.trim().split('\n').at(-1) ?? ''}`] };
      lines.push(`registered ${taskPath(d.kind)}`);
    } finally {
      rmSync(file, { force: true });
    }
  }
  lines.push(`the daily set runs at ${i.at}, WAL every 15 minutes; \`pnpm stack:backup status\` shows their last runs`);
  return { ok: true, lines };
}
