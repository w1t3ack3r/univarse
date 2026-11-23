// Spec 0019 LS4: what the migrate smoke requires of its two runs. `node --test tools/images/migrate-smoke.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smokeProblems } from './migrate-smoke.mjs';

const first = {
  status: 0,
  output: '[migrate] bootstrap: roles, databases, privileges\n  ✓ role univarse_relay_platform (created)\n  ✓ role univarse_console (created)\n[migrate] platform: 24 migration(s) applied\n[migrate] shard pool-01: 12 migration(s) applied, rls:check passed\n  ✓ created data key v1 for demo-uni (local:test)\n[migrate] done',
};
const second = { status: 0, output: 'No pending migrations to apply.\n[migrate] shard pool-01: 0 migration(s) applied, rls:check passed\n  · kept    data key v1 for demo-uni (local:test)\n[migrate] done' };
const secrets = { roles: 'f'.repeat(48) };

test('[LS4] two good runs pass', () => {
  assert.deepEqual(smokeProblems(first, second, secrets), []);
});

test('[LS4] a failed run, a second run that migrated again, or a leaked secret each fail', () => {
  assert.match(smokeProblems({ ...first, status: 1 }, second, secrets).join(), /first run/);
  assert.match(smokeProblems(first, { ...second, output: second.output.replace('No pending migrations to apply.', 'applied') }, secrets).join(), /No pending/);
  assert.match(smokeProblems({ ...first, output: `${first.output}\n${secrets.roles}` }, second, secrets).join(), /contains roles/);
});

test('[spec 0039 Q9] a first run that migrated no shard, or a second that migrated the pool again, fails', () => {
  const noShard = { ...first, output: first.output.replace('[migrate] shard pool-01: 12 migration(s) applied, rls:check passed\n', '') };
  assert.match(smokeProblems(noShard, second, secrets).join(), /shard pool-01/);
  const again = { ...second, output: second.output.replace('pool-01: 0 migration(s)', 'pool-01: 3 migration(s)') };
  assert.match(smokeProblems(first, again, secrets).join(), /second run/);
});

test('[spec 0027 P5] a first run that did not create the console role fails', () => {
  const without = { ...first, output: first.output.replace('  ✓ role univarse_console (created)\n', '') };
  assert.match(smokeProblems(without, second, secrets).join(), /univarse_console/);
});
