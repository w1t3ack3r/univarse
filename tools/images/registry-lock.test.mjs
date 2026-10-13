// Spec 0013 LR8: the registry lock. Run with `node --test tools/images/registry-lock.test.mjs`.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireRegistryLock, LOCK_NAME } from './registry-lock.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'uv-lock-'));

test('[LR8] a second writer is refused while the lock is held, and the refusal names the holder', () => {
  const dir = fresh();
  const a = acquireRegistryLock(dir, 'release', { pid: 111 });
  assert.throws(
    () => acquireRegistryLock(dir, 'prune --apply', { pid: 222 }),
    /locked by release \(pid 111/,
  );
  a.release();
  const b = acquireRegistryLock(dir, 'prune --apply', { pid: 222 });
  b.release();
  assert.equal(existsSync(join(dir, LOCK_NAME)), false);
});

test('[LR8] a stale or half-written lock is never taken over automatically', () => {
  const dir = fresh();
  acquireRegistryLock(dir, 'release', { pid: 999999 }); // "crashed": never released
  assert.throws(
    () => acquireRegistryLock(dir, 'prune --apply'),
    /locked by release \(pid 999999.*remove .* yourself/,
  );
  writeFileSync(join(dir, LOCK_NAME, 'owner.json'), '{"hol'); // half-written
  assert.throws(() => acquireRegistryLock(dir, 'prune --apply'), /locked by unknown holder/);
});

test('[LR8] releasing removes only this run’s own lock', () => {
  const dir = fresh();
  const a = acquireRegistryLock(dir, 'release');
  // Someone removed the lock by hand and another run took it: a's late release must not remove it.
  const owner = join(dir, LOCK_NAME, 'owner.json');
  writeFileSync(owner, JSON.stringify({ holder: 'deploy', pid: 5, since: 'x', token: 'other' }));
  a.release();
  assert.equal(JSON.parse(readFileSync(owner, 'utf8')).holder, 'deploy');
});
