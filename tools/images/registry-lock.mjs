// Spec 0013 LR8: one writer at a time for the local registry. `pnpm images:release`, `pnpm images:prune --apply`
// and the local deploy (when built) each hold this lock for their WHOLE run, so a prune never interleaves with a
// release's pushes and signatures, or with a deploy reading the digests it is about to run.
//
// The lock is a directory created atomically (mkdir fails if it exists) holding owner.json. It is never taken
// over automatically: a stale lock (a crashed run) is reported with its holder, and the owner removes it after
// checking that the process is gone. Releasing checks the token, so a run only ever removes its own lock.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_NAME = '.registry.lock';

/** Take the lock in `dir` for `holder` (e.g. "release", "prune --apply"). Throws, naming the holder, if held. */
export function acquireRegistryLock(
  dir,
  holder,
  { pid = process.pid, now = () => new Date().toISOString() } = {},
) {
  const lock = join(dir, LOCK_NAME);
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(lock); // atomic: exactly one concurrent caller succeeds
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner = 'unknown holder';
    try {
      const o = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      owner = `${o.holder} (pid ${o.pid}, since ${o.since})`;
    } catch {
      // being written, or left half-written by a crash: still held
    }
    throw new Error(
      `the local registry is locked by ${owner}. Wait for it to finish. If that process is gone, remove ${lock} yourself.`,
      { cause: e },
    );
  }
  const token = randomUUID();
  writeFileSync(
    join(lock, 'owner.json'),
    `${JSON.stringify({ holder, pid, since: now(), token })}\n`,
  );
  let released = false;
  return {
    token,
    release() {
      if (released) return;
      released = true;
      try {
        const o = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        if (o.token !== token) return; // not ours any more: never remove another run's lock
      } catch {
        return;
      }
      rmSync(lock, { recursive: true, force: true });
    },
  };
}
