// Spec 0039 Q5, Q6, Q13, Q-A4 (S8 PR B): `pnpm stack:shards`, the owner's command on the host. It runs the `shards` job
// from the deployed migrate image (shards.env: the migrate job's settings, the superuser only to create and drop a
// dedicated database) and says in plain words what happened:
//   ready [--count <1-10>]                          new dedicated databases, made ready in advance
//   migrate <shard> [--applied|--rolled-back <m>]   a shard's migrations again, a failed one settled as you say
//   retire <shard> --confirm <shard>                a dedicated database whose institutions are all purged, dropped
//   drill                                           criterion 9's migration drill
//   list                                            the budget and every shard
// For `retire`, the host adds the newest complete backup set's time: the job drops nothing a set hasn't covered.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadSettings } from './backup/config.js';
import { listSets, type SetOnDisk } from './backup/set.js';
import { COMPOSE_FILE, PROJECT, STACK_DIR } from './config.js';
import { docker } from './docker.js';
import { deployedImages } from './ledger/job.js';
import type { JobRun } from './purge.js';

const JOB_TIMEOUT_MS = 20 * 60_000;
export const SHARDS_USAGE =
  'usage: pnpm stack:shards ready [--count <1-10>] | migrate <shard> [--applied <migration> | --rolled-back <migration>] | retire <shard> --confirm <shard> | drill | list';
/** Q5: below this many ready dedicated databases, `list` warns (the migrate app's MINIMUM_READY). */
export const MINIMUM_READY = 2;

export interface ShardsDeps {
  job(args: readonly string[]): JobRun;
  /** The newest complete backup set's time, or null when there's none. */
  newestSet(): Date | null;
}

/** The newest set with an index (a complete one). Pure. */
export function newestComplete(sets: readonly SetOnDisk[]): Date | null {
  return sets.filter((s) => s.index !== null).reduce<Date | null>((a, s) => (!a || s.createdAt > a ? s.createdAt : a), null);
}

const SHARD = /^(pool-[0-9]{2}|t-[a-z0-9]{12})$/;

/** The job's arguments for a command, or an error saying why not. `retire` gains the newest set's time. */
export function jobArgs(argv: readonly string[], newestSet: () => Date | null): readonly string[] {
  const [cmd, ...rest] = argv;
  if (cmd === 'retire') {
    const [shard, flag, confirm, ...more] = rest;
    if (!shard || !SHARD.test(shard) || flag !== '--confirm' || !confirm || more.length) throw new Error(SHARDS_USAGE);
    if (confirm !== shard) throw new Error(`--confirm must repeat the shard's name exactly: ${shard}, not ${confirm}. Nothing was changed.`);
    const set = newestSet();
    return ['retire', shard, '--confirm', shard, ...(set ? ['--backup-after', set.toISOString()] : [])];
  }
  if (cmd === 'ready' || cmd === 'migrate' || cmd === 'drill' || cmd === 'list') return [cmd, ...rest];
  throw new Error(SHARDS_USAGE);
}

interface Made {
  name: string;
  database: string;
  status: string;
  code: string | null;
  reachable: boolean;
}
interface Listed {
  server: string;
  left: number;
  room: number;
  ready: number;
  shards: { name: string; kind: string; status: string; institutions: number; lastRun: string | null }[];
}

/** What the job's JSON says, in plain lines; ok only when everything asked for happened. */
export function report(cmd: string, r: JobRun): { ok: boolean; lines: string[] } {
  const j = r.json;
  if (r.status === 3 && j && j.ok === false) return { ok: false, lines: [`refused: ${String(j.refused)}. Nothing was changed.`] };
  if (r.status !== 0 || !j || j.ok !== true) return { ok: false, lines: [`the shards job failed (exit ${String(r.status)}): ${r.error || 'no output'}`] };
  switch (cmd) {
    case 'ready': {
      const made = (j.made ?? []) as Made[];
      const lines = made.map((m) =>
        m.status === 'READY' && m.reachable
          ? `${m.name} (${m.database}): ready, migrated, and reachable through PgBouncer as the app.`
          : m.status === 'READY'
            ? `${m.name} (${m.database}): ready, but NOT reachable through PgBouncer as the app: check PgBouncer's fallback entry before it's used.`
            : `${m.name} (${m.database}): its migration FAILED (${m.code ?? 'unexpected'}); it is in maintenance. See the runbook in docs/10 §4.`,
      );
      return { ok: made.length > 0 && made.every((m) => m.status === 'READY' && m.reachable), lines };
    }
    case 'migrate':
      return j.migrated === true
        ? { ok: true, lines: ['migrated; the shard is back in service.'] }
        : { ok: false, lines: [`its migration FAILED (${typeof j.code === 'string' ? j.code : 'unexpected'}); it stays in maintenance. See the runbook in docs/10 §4.`] };
    case 'retire':
      return { ok: true, lines: [`its database ${String(j.database)} is dropped and the shard is retired (${String(j.institutions)} purged institution(s) had lived there).`] };
    case 'drill':
      return j.recovered === true && j.failedWith
        ? { ok: true, lines: [`${String(j.name)}: failed its first migration (${typeof j.failedWith === 'string' ? j.failedWith : 'unknown'}) and went into maintenance; settled and migrated again, it is ready. The drill passed.`] }
        : { ok: false, lines: [`the drill did not pass: ${String(j.name)} ${j.failedWith ? 'failed as it should but was not recovered' : 'did not fail as it should'}.`] };
    case 'list': {
      const l = j as unknown as Listed;
      const lines = [
        `server ${l.server}: ${String(l.left)} connection(s) left, room for ${String(l.room)} more dedicated database(s)`,
        ...l.shards.map((s) => `  ${s.name.padEnd(16)} ${s.kind.padEnd(9)} ${s.status.padEnd(11)} ${String(s.institutions).padStart(3)} institution(s)  last run: ${s.lastRun ?? 'none'}`),
      ];
      if (l.ready < MINIMUM_READY) lines.push(`WARN only ${String(l.ready)} dedicated database(s) ready; keep ${String(MINIMUM_READY)}: pnpm stack:shards ready --count ${String(MINIMUM_READY - l.ready)}`);
      return { ok: true, lines };
    }
    default:
      return { ok: false, lines: [SHARDS_USAGE] };
  }
}

/** The `shards` job from the deployed images: its env file is shards.env, nothing else. */
function runJob(images: Readonly<Record<string, string>>, args: readonly string[]): JobRun {
  const name = `uv-shards-${String(Date.now())}`;
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'run', '--rm', '-T', '--name', name, 'shards', '--enable-source-maps', 'dist/shards-main.js', ...args], {
    encoding: 'utf8',
    timeout: JOB_TIMEOUT_MS,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...images },
  });
  if (r.status !== 0 && r.status !== 3) docker(['rm', '-f', '-v', name], { allowFail: true });
  // Progress lines are shown as they were; the last line is the JSON answer.
  const lines = r.stdout.trim().split('\n');
  for (const l of lines.slice(0, -1)) if (l.trim()) console.log(`  ${l}`);
  let json: Record<string, unknown> | null;
  try {
    const v = JSON.parse(lines.at(-1) ?? '') as unknown;
    json = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: r.error ? null : r.status, json, error: (r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200) };
}

export function shards(deps: ShardsDeps, argv: readonly string[]): { ok: boolean; lines: string[] } {
  const args = jobArgs(argv, () => deps.newestSet());
  return report(args[0] ?? '', deps.job(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const images = deployedImages();
    const r = shards({ job: (a) => runJob(images, a), newestSet: () => newestComplete(listSets(loadSettings().destination)) }, process.argv.slice(2));
    for (const l of r.lines) (r.ok ? console.log : console.error)(`[stack:shards] ${l}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`[stack:shards] ${(e as Error).message}`);
    process.exit(1);
  }
}
