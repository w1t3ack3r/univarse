// Spec 0017 PB10: the newer-upstream-release safeguard.
// Run: node --test tools/images/pgbouncer-upstream.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPin, compareVersions, releaseVersions } from './pgbouncer-upstream.mjs';

const ref = (tag) => `0123456789abcdef0123456789abcdef01234567\trefs/tags/${tag}`;
const LS = [
  'pgbouncer_1_9_0',
  'pgbouncer_1_10_0',
  'pgbouncer_1_23_1',
  'pgbouncer_1_23_1-fixed',
  'pgbouncer_1_26_0',
  'pgbouncer_1_26_1',
  'pgbouncer_1_27_0_rc1',
  'v1.30.0',
]
  .map(ref)
  .join('\n');

test('[PB10] upstream: only exact pgbouncer_X_Y_Z tags are releases, sorted numerically (1.9 before 1.10)', () => {
  assert.deepEqual(releaseVersions(`${LS}\n`), ['1.9.0', '1.10.0', '1.23.1', '1.26.0', '1.26.1']);
  assert.deepEqual(releaseVersions(`${LS}\r\n`.replace(/\n/g, '\r\n')), [
    '1.9.0',
    '1.10.0',
    '1.23.1',
    '1.26.0',
    '1.26.1',
  ]);
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.equal(compareVersions('1.26.1', '1.26.1'), 0);
});

test('[PB10] upstream: a newer release than the pin fails, naming it (1.26.1 against a 1.26.0 pin)', () => {
  const r = checkPin('1.26.0', releaseVersions(LS));
  assert.equal(r.ok, false);
  assert.deepEqual(r.newer, ['1.26.1']);
  assert.match(
    r.problems.join('\n'),
    /released PgBouncer 1\.26\.1, newer than the pinned 1\.26\.0/,
  );
});

test('[PB10] upstream: the latest release pinned passes; a release candidate or re-tag is not "newer"', () => {
  const r = checkPin('1.26.1', releaseVersions(LS));
  assert.deepEqual(r, { ok: true, newer: [], problems: [] });
});

test('[PB10] upstream: fails closed: no tags read, a malformed pin, or a pin upstream never released', () => {
  assert.match(checkPin('1.26.1', []).problems.join(), /no upstream release tags were read/);
  assert.equal(checkPin('1.26.1', releaseVersions('garbage\n')).ok, false);
  assert.match(checkPin(undefined, ['1.26.1']).problems.join(), /not X\.Y\.Z/);
  assert.match(checkPin('1.26', ['1.26.1']).problems.join(), /not X\.Y\.Z/);
  const unknown = checkPin('1.26.9', releaseVersions(LS));
  assert.equal(unknown.ok, false);
  assert.match(unknown.problems.join(), /pinned 1\.26\.9 is not among upstream's releases/);
});
