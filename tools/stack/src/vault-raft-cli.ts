// Spec 0020 B-4: `pnpm stack:vault migrate-raft <releases/record.json> [--commit <sha>]`, the owner's one-time step.
// The record is the release being deployed: verified exactly as the deploy verifies it (its images by digest, the
// commit from the checkout), under the registry lock, because its API image's `keys verify-unwrap` is the final check.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, RELEASES, STACK_DIR } from './config.js';
import { imagesFrom } from './deploy.js';
import { compose, registry } from './deploy-deps.js';
import { docker } from './docker.js';
import { composeRunner } from './ledger/job.js';
import { acquireRegistryLock, verifyRelease, type ReleaseRecord } from './release.js';
import { STACK_VAULT } from './vault.js';
import { migrateRaft } from './vault-raft.js';
import { ensureDataVolumes } from './volumes.js';

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
    const keys = composeRunner(images);
    return migrateRaft({
      run: docker,
      target: STACK_VAULT,
      dir: STACK_DIR,
      compose: (args) => compose(args, images),
      verifyUnwrap: () => {
        const r = keys(['verify-unwrap']);
        return { ok: r.status === 0, lines: r.stdout.trim().split('\n').filter(Boolean).slice(-5) };
      },
      ensureDataVolumes: () => {
        ensureDataVolumes();
      },
      log: (l) => {
        console.log(`[stack:vault] ${l}`);
      },
    });
  } finally {
    stopRegistry();
    lock.release();
  }
}
