// Spec 0019 LS4: what the migrate smoke requires of its two runs. `node --test tools/images/migrate-smoke.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { smokeProblems } from './migrate-smoke.mjs';

const first = {
  status: 0,
  output: '[migrate] bootstrap: roles, databases, privileges\n  ✓ role univarse_relay_platform (created)\n[migrate] rls:check passed: 14 tenant tables isolated\n  ✓ created data key v1 for demo-uni (local:test)\n[migrate] done',
};
const second = { status: 0, output: 'No pending migrations to apply.\n  · kept    data key v1 for demo-uni (local:test)\n[migrate] done' };
const secrets = { roles: 'f'.repeat(48) };

test('[LS4] two good runs pass', () => {
  assert.deepEqual(smokeProblems(first, second, secrets), []);
});

test('[LS4] a failed run, a second run that migrated again, or a leaked secret each fail', () => {
  assert.match(smokeProblems({ ...first, status: 1 }, second, secrets).join(), /first run/);
  assert.match(smokeProblems(first, { ...second, output: second.output.replace('No pending migrations to apply.', 'applied') }, secrets).join(), /No pending/);
  assert.match(smokeProblems({ ...first, output: `${first.output}\n${secrets.roles}` }, second, secrets).join(), /contains roles/);
});
