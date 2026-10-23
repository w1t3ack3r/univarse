// Spec 0020 (where the database step runs), A2-6, A2-8: the KeysDb the protocol drives, as a one-shot `keys` job from
// the deployed, verified API image, on the stack's app network, with its own env file (keys.env). The host reads the
// last JSON line of its output. Exit 0 or 3 is a definite answer; anything else (a crash, a timeout, no JSON) is an
// unknown outcome. Before deciding that, the job's container is force-removed, so a client killed by its timeout can't
// leave a destruction running that commits later.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPOSE_FILE, PROJECT, RELEASES, STACK_DIR } from '../config.js';
import { docker } from '../docker.js';
import { canonical, type DestructionKind, type Entry } from './chain.js';
import type { AdoptOutcome, CheckResult, DestroyOutcome, Evidence, KeysDb, ReapplyOutcome } from './protocol.js';
import { GENERATION_DIR } from './store.js';

const JOB_TIMEOUT_MS = 5 * 60_000;

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The compose variables of what is deployed now (deploy-state.json), for commands run outside a deploy. */
export function deployedImages(file = join(RELEASES, 'deploy-state.json')): Record<string, string> {
  if (!existsSync(file)) throw new Error('nothing is deployed (no releases/deploy-state.json): run `pnpm stack:deploy` first');
  const images = (JSON.parse(readFileSync(file, 'utf8')) as { images?: Record<string, string> }).images;
  if (!images?.UNIVARSE_API_IMAGE) throw new Error('the deploy state names no API image: deploy once with this version of the stack tools');
  return images;
}

/** Runs the keys CLI with these arguments; `op` is the destruction job's op (UNIVARSE_DESTRUCTION_OP). */
export type Runner = (args: readonly string[], opts?: { op?: string; input?: string }) => Run;

/** The `keys` compose job from the given images (A2-6). */
export const composeRunner = (images: Readonly<Record<string, string>>): Runner => (args, opts = {}) => runJob(images, args, opts);

function runJob(images: Readonly<Record<string, string>>, args: readonly string[], opts: { op?: string; input?: string }): Run {
  const name = `uv-keys-${opts.op ?? randomUUID()}`;
  const r = spawnSync(
    'docker',
    ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--profile', 'job', 'run', '--rm', '-T', '--name', name, ...(opts.op ? ['-e', `UNIVARSE_DESTRUCTION_OP=${opts.op}`] : []), 'keys', '--enable-source-maps', 'dist/cli/keys.js', ...args],
    {
      encoding: 'utf8',
      timeout: JOB_TIMEOUT_MS,
      ...(opts.input === undefined ? {} : { input: opts.input }),
      env: { ...process.env, MSYS_NO_PATHCONV: '1', UNIVARSE_STACK_DIR: STACK_DIR, ...images },
    },
  );
  if (r.status !== 0 && r.status !== 3) docker(['rm', '-f', name], { allowFail: true }); // A2-8: never left running
  return { status: r.error ? null : r.status, stdout: r.stdout, stderr: r.stderr };
}

function lastJson(r: Run): Record<string, unknown> | null {
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short, secret-free account of a failed run: its exit and the last error line (application messages only). */
const detail = (r: Run) => `exit ${r.status === null ? 'none (timed out or not started)' : String(r.status)}${r.stderr.trim() ? `: ${(r.stderr.trim().split('\n').at(-1) ?? '').slice(0, 200)}` : ''}`;

function definite(r: Run, what: string): Record<string, unknown> {
  const out = lastJson(r);
  if (r.status !== 0 || !out) throw new Error(`the keys job's ${what} failed (${detail(r)})`);
  return out;
}

export const keysJob = (images: Readonly<Record<string, string>>): KeysDb => keysDbFrom(composeRunner(images));

/** The KeysDb over any way of running the keys CLI (the compose job; the integration test runs it directly). */
export function keysDbFrom(run: Runner): KeysDb {
  return {
    check(slug, version) {
      const r = run(['destroy-check', slug, ...(version === undefined ? [] : ['--version', String(version)])]);
      const out = lastJson(r);
      if (!out || (r.status !== 0 && r.status !== 1)) throw new Error(`the keys job's check failed (${detail(r)})`);
      if (out.eligible !== true) return Promise.resolve({ eligible: false, why: (typeof out.why === 'string' ? out.why : 'not eligible') + (typeof out.remaining === 'number' && out.remaining ? ` (${String(out.remaining)} values)` : '') });
      return Promise.resolve({
        eligible: true,
        tenantId: String(out.tenantId),
        kind: out.kind as DestructionKind,
        versions: out.versions as number[],
        preconditions: (out.preconditions ?? {}) as Record<string, unknown>,
      } satisfies CheckResult);
    },
    destroy(op, slug, version) {
      const r = run(['destroy', slug, '--op', op, ...(version === undefined ? [] : ['--version', String(version)])], { op });
      const out = lastJson(r);
      if (r.status === 3 && out?.outcome === 'refused') return Promise.resolve({ outcome: 'refused', why: String(out.why) });
      if (r.status === 0 && out?.outcome === 'committed' && out.op === op)
        return Promise.resolve({
          outcome: 'committed',
          tenantId: String(out.tenantId),
          kind: out.kind as DestructionKind,
          versions: out.versions as number[],
          destroyedAt: String(out.destroyedAt),
          auditSeq: String(out.auditSeq),
          forget: (out.forget ?? []) as string[],
        } satisfies DestroyOutcome);
      return Promise.resolve({ outcome: 'unknown', detail: detail(r) });
    },
    evidence(tenantIds, opts = {}) {
      return Promise.resolve(definite(run(['evidence', ...(opts.legacy ? ['--legacy'] : []), ...tenantIds.flatMap((id) => ['--tenant-id', id])]), 'evidence') as unknown as Evidence);
    },
    adopt(op, tenantId, kind, versions) {
      const r = run(['adopt', '--op', op, '--tenant-id', tenantId, '--kind', kind, '--versions', versions.join(',')], { op });
      const out = lastJson(r);
      if (r.status === 3 && out?.outcome === 'refused') return Promise.resolve({ outcome: 'refused', why: String(out.why) });
      if (r.status === 0 && out?.outcome === 'adopted')
        return Promise.resolve({ outcome: 'adopted', recorded: out.recorded === true, versions: out.versions as number[], destroyedAt: String(out.destroyedAt), auditSeq: String(out.auditSeq) } satisfies AdoptOutcome);
      return Promise.resolve({ outcome: 'unknown', detail: detail(r) });
    },
    reapply(op, tenantId, kind, versions) {
      const r = run(['reapply', '--op', op, '--tenant-id', tenantId, '--kind', kind, '--versions', versions.join(',')], { op });
      const out = lastJson(r);
      if (r.status === 3 && out?.outcome === 'refused') return Promise.resolve({ outcome: 'refused', why: String(out.why) });
      if (r.status === 0 && out?.outcome === 'reapplied')
        return Promise.resolve({
          outcome: 'reapplied',
          destroyed: out.destroyed as number[],
          recorded: out.recorded === true,
          activeDestroyed: out.activeDestroyed === true,
          forget: (out.forget ?? []) as string[],
        } satisfies ReapplyOutcome);
      return Promise.resolve({ outcome: 'unknown', detail: detail(r) });
    },
    audit(action, d) {
      definite(run(['ledger-audit', '--action', action, '--detail', JSON.stringify(d)]), 'audit');
      return Promise.resolve();
    },
    copyToBucket(ledgerId, entries: readonly Entry[]) {
      const r = run(['ledger-copy', '--ledger', ledgerId, '--generation', GENERATION_DIR], { input: entries.map((e) => canonical(e)).join('\n') });
      return Promise.resolve(r.status === 0 && lastJson(r)?.outcome === 'copied' ? null : detail(r));
    },
  };
}
