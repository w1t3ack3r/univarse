// Spec 0013 LR10 regression tests: a release removes and stops only what it owns. A fake `sh` records every
// command (no Docker). Run with `node --test tools/images/release-cleanup.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cleanupRun, ensureService, newRun, stopIfStarted } from './release-cleanup.mjs';
import { RUN_LABEL } from './release-lib.mjs';

const compose = ['compose', '-f', 'x.yml'];
/** A fake sh: `running` services, `owned` container IDs for the label filter, and an optional failing `up`. */
function fakeSh({ running = [], owned = [], failUp = false } = {}) {
  const calls = [];
  const sh = (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('ps') && args.includes('--services')) return { status: 0, stdout: running.join('\r\n') };
    if (args[0] === 'ps' && args.includes('-aq')) return { status: 0, stdout: owned.join('\n') };
    if (args.includes('up') && failUp) throw new Error('up --wait failed: container unhealthy');
    return { status: 0, stdout: '' };
  };
  return { sh, calls };
}

test('[LR10] fix 3: a run that fails before starting anything (e.g. a dirty tree) removes and stops nothing', () => {
  const run = newRun('r1');
  const { sh, calls } = fakeSh({ owned: [] });
  cleanupRun(run, { sh, compose });
  assert.equal(calls.filter((c) => c.startsWith('rm')).length, 0, 'no docker rm at all');
  assert.equal(calls.filter((c) => c.includes(' stop ')).length, 0, 'no service stopped');
  assert.deepEqual(calls, [`ps -aq --filter label=${RUN_LABEL}=r1`]);
});

test('[LR10] fix 3: cleanup removes exactly the containers labelled with this run, never by name', () => {
  const run = newRun('r2');
  const { sh, calls } = fakeSh({ owned: ['c0ffee', 'beef01'] });
  cleanupRun(run, { sh, compose });
  assert.ok(calls.includes(`ps -aq --filter label=${RUN_LABEL}=r2`));
  assert.ok(calls.includes('rm -f c0ffee beef01'));
  assert.ok(!calls.some((c) => /rm -f .*uv-/.test(c)), 'no removal by fixed name');
});

test('[LR10] fix 3: a service that was already running is never recorded or stopped', () => {
  const run = newRun('r3');
  const { sh, calls } = fakeSh({ running: ['clamav'] });
  assert.equal(ensureService(run, 'clamav', { sh, compose }), false);
  stopIfStarted(run, 'clamav', { sh, compose });
  cleanupRun(run, { sh, compose });
  assert.equal(calls.filter((c) => c.includes(' stop ')).length, 0);
});

test('[LR10] fix 3: a service whose startup FAILS is still stopped by cleanup', () => {
  const run = newRun('r4');
  const { sh, calls } = fakeSh({ running: [], failUp: true });
  assert.throws(() => ensureService(run, 'registry', { sh, compose, profile: ['--profile', 'release'] }), /up --wait failed/);
  cleanupRun(run, { sh, compose });
  assert.ok(calls.includes('compose -f x.yml --profile release stop registry'), 'the half-started service is stopped');
});

test('[LR10] fix 3: the release source no longer removes containers by fixed name', () => {
  const src = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /'rm', '-f', 'uv-/);
  assert.match(src, /cleanupRun\(RUN/);
});

test('[LR8] every push goes through pushTag: recorded in the record refs, and its host tag copy removed at cleanup', () => {
  const src = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.equal(src.match(/sh\('docker', \['push'/g)?.length, 1, 'exactly one push call, inside pushTag');
  assert.match(src, /function pushTag[\s\S]*?hostTags\.push\(ref\);[\s\S]*?record\.refs\.push\(\{ repo, tag \}\);[\s\S]*?\['push', ref\]/);
  assert.match(src, /function cleanup\(\) \{[\s\S]*?sh\('docker', \['image', 'rm', \.\.\.hostTags\]/);
});
