// Spec 0020 B-4: `pnpm stack:vault migrate-raft <releases/record.json> [--commit <sha>]`, the owner's one-time step.
// The record is the release being deployed: verified exactly as the deploy verifies it (its images by digest, the
// commit from the checkout), under the registry lock, because its API image's `keys verify-unwrap` is the final check.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, RELEASES, STACK_DIR } from './config.js';
import { imagesFrom } from './deploy.js';
import { compose, registry, writeEnvFiles } from './deploy-deps.js';
import { docker } from './docker.js';
import { composeRunner } from './ledger/job.js';
import { acquireRegistryLock, verifyRelease, type ReleaseRecord } from './release.js';
import { STACK_VAULT } from './vault.js';
import { printer } from './print.js';
import { migrateRaft } from './vault-raft.js';
import { ensureDataVolumes } from './volumes.js';

/**
 * The keys job's answer, as migrate-raft reports it. On failure, its stderr's last lines too: a job that fails before
 * its check (a configuration it refuses, Vault unreachable) says why only there. The API's errors name settings and
 * paths, never values (CLAUDE.md invariant 8).
 */
export function verifyUnwrapLines(j: { status: number | null; stdout: string; stderr: string }): { ok: boolean; lines: string[] } {
  const tail = (t: string) => t.trim().split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-5);
  if (j.status === 0) return { ok: true, lines: tail(j.stdout) };
  const why = j.status === null ? 'the keys job did not finish' : `the keys job exited ${String(j.status)}`;
  return { ok: false, lines: [...tail(j.stdout), ...tail(j.stderr), why] };
}

/** Runs `step` with a log that prints each line as it comes, and returns only the lines after those (its outcome). */
export function printedAsItGoes(
  step: (log: (l: string) => void) => { ok: boolean; lines: string[] },
  print: (l: string) => void = (l) => {
    console.log(`[stack:vault] ${l}`);
  },
): { ok: boolean; lines: string[] } {
  const p = printer(print);
  return p.unprinted(step(p.log));
}

export function migrateRaftCli(argv: readonly string[]): { ok: boolean; lines: string[] } {
  const [arg0, ...rest] = argv;
  const file = arg0 ? resolve(process.env.INIT_CWD ?? process.cwd(), arg0) : undefined;
  if (!file || !existsSync(file)) return { ok: false, lines: ['usage: pnpm stack:vault migrate-raft <releases/record.json> [--commit <sha>]  (the release you are deploying)'] };
  const at = rest.indexOf('--commit');
  const commit = at >= 0 ? (rest[at + 1] ?? '') : spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const lock = acquireRegistryLock(RELEASES, 'vault migrate-raft');
  let stopRegistry = () => undefined as unknown;
  try {
    // Verification and the keys job read the local registry, as in a deploy.
    stopRegistry = registry();
    const v = verifyRelease(JSON.parse(readFileSync(file, 'utf8')) as ReleaseRecord, { commit });
    if (!v.ok) return { ok: false, lines: v.problems };
    const { images, problems } = imagesFrom(v);
    if (problems.length) return { ok: false, lines: problems };
    // The keys job reads keys.env: rewritten with the app token, in case a deploy that stopped before its Vault step
    // left it blank (the API's config refuses a blank token, so the job would fail before checking anything).
    writeEnvFiles(false);
    const keys = composeRunner(images);
    return printedAsItGoes((log) => migrateRaft({
      run: docker,
      target: STACK_VAULT,
      dir: STACK_DIR,
      compose: (args) => compose(args, images),
      verifyUnwrap: () => {
        const j = keys(['verify-unwrap']);
        return verifyUnwrapLines(j);
      },
      ensureDataVolumes: () => {
        ensureDataVolumes();
      },
      log,
    }));
  } finally {
    stopRegistry();
    lock.release();
  }
}
