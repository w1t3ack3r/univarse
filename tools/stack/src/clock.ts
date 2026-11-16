// Spec 0038 Q-D1–Q-D4: `pnpm stack:clock archive <slug> --confirm <slug>`, the owner's test clock on the host. It runs
// the `clock` job from the deployed API image (clock.env: the app's two database URLs, nothing else), which archives
// that one institution now, as if its window had ended, through the worker's own code: no warning, no other clock or
// institution moved, the real time recorded and the audit saying `testClock`. Only an institution leaving that never
// went live; the slug is given twice, so a slip of it changes nothing.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { COMPOSE_FILE, PROJECT, STACK_DIR } from './config.js';
import { docker } from './docker.js';
import { deployedImages } from './ledger/job.js';
import type { JobRun } from './purge.js';

const JOB_TIMEOUT_MS = 5 * 60_000;
export const CLOCK_USAGE = 'usage: pnpm stack:clock archive <slug> --confirm <slug>';

export interface ClockDeps {
  job(args: readonly string[]): JobRun;
}

/** Exactly `archive <slug> --confirm <the same slug>`. */
export function parseClockArgs(argv: readonly string[]): { slug: string } {
  const [command, slug, flag, confirm, ...rest] = argv;
  if (command !== 'archive' || !slug || slug.startsWith('-') || flag !== '--confirm' || !confirm || rest.length) throw new Error(CLOCK_USAGE);
  if (confirm !== slug) throw new Error(`--confirm must repeat the slug exactly: ${slug}, not ${confirm}. Nothing was changed.`);
  return { slug };
}

const WHY: Readonly<Record<string, string>> = {
  no_tenant: 'no institution has this slug',
  not_offboarding: 'it is not in an offboarding window (not leaving, cancelled, or suspended: resume it first)',
  went_live: 'it went live, and the test clock never closes early an institution that went live',
};

export function clock(deps: ClockDeps, req: { slug: string }): { ok: boolean; lines: string[] } {
  const r = deps.job(['archive', req.slug, '--confirm', req.slug]);
  const j = r.json;
  if (r.status === 3 && j && j.ok === false) {
    const code = String(j.refused);
    return { ok: false, lines: [`${req.slug}: refused (${code}): ${WHY[code] ?? 'see the code'}. Nothing was changed.`] };
  }
  if (r.status !== 0 || !j || j.ok !== true) return { ok: false, lines: [`${req.slug}: the clock job failed (exit ${String(r.status)}): ${r.error || 'no output'}. Run it again; it is safe to repeat.`] };
  const sessions = j.sessionsEnded === true ? '; its sessions ended' : '';
  if (j.archived === 'already') return { ok: true, lines: [`${req.slug}: already archived; nothing else changed${sessions}.`] };
  const days = Number(j.daysLeft);
  return {
    ok: true,
    lines: [`${req.slug}: archived now by the test clock, ${String(days)} day${days === 1 ? '' : 's'} before its window's end${sessions}. The audit records it as a test-clock archive.`],
  };
}

/** The `clock` job from the deployed images: its env file is clock.env, nothing else (Q-D1). */
function runJob(images: Readonly<Record<string, string>>, args: readonly string[]): JobRun {
  const name = `uv-clock-${String(Date.now())}`;
  const r = spawnSync('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'run', '--rm', '-T', '--name', name, 'clock', '--enable-source-maps', 'dist/cli/test-clock.js', ...args], {
    encoding: 'utf8',
    timeout: JOB_TIMEOUT_MS,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...images },
  });
  if (r.status !== 0 && r.status !== 3) docker(['rm', '-f', '-v', name], { allowFail: true });
  const last = r.stdout.trim().split('\n').at(-1) ?? '';
  let json: Record<string, unknown> | null;
  try {
    const v = JSON.parse(last) as unknown;
    json = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: r.error ? null : r.status, json, error: (r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const req = parseClockArgs(process.argv.slice(2));
    const images = deployedImages();
    const r = clock({ job: (args) => runJob(images, args) }, req);
    for (const l of r.lines) (r.ok ? console.log : console.error)(`[stack:clock] ${l}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`[stack:clock] ${(e as Error).message}`);
    process.exit(1);
  }
}
