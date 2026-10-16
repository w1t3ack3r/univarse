// Spec 0017 PB3: the comparison of the direct and PgBouncer runs. Run: node --test tools/pgbouncer/compare.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRuns, compareSuite, relativeTestFile, SUITES } from './compare.mjs';

const report = (files) => ({
  testResults: Object.entries(files).map(([name, tests]) => ({
    name,
    assertionResults: tests.map(([fullName, status]) => ({ fullName, status })),
  })),
});
const DIRECT = '/home/runner/work/univarse/univarse/packages/db/test/isolation.int.spec.ts';
const BOUNCED = 'D:\\a\\univarse\\univarse\\packages\\db\\test\\isolation.int.spec.ts';
const base = {
  [DIRECT]: [
    ['A', 'passed'],
    ['B', 'passed'],
    ['C', 'skipped'],
  ],
};
const same = {
  [BOUNCED]: [
    ['A', 'passed'],
    ['B', 'passed'],
    ['C', 'skipped'],
  ],
};

test('[PB3] identical runs (from different checkouts and path styles) compare clean', () => {
  assert.deepEqual(compareSuite('db', report(base), report(same)).problems, []);
  assert.equal(relativeTestFile(BOUNCED), 'packages/db/test/isolation.int.spec.ts');
  assert.throws(() => relativeTestFile('/tmp/x.spec.ts'), /outside apps\/ and packages\//);
});

test('[PB3] a test that failed through PgBouncer fails the comparison', () => {
  const r = compareSuite(
    'db',
    report(base),
    report({
      [BOUNCED]: [
        ['A', 'passed'],
        ['B', 'failed'],
        ['C', 'skipped'],
      ],
    }),
  );
  assert.match(r.problems.join('\n'), /B failed through PgBouncer/);
});

test('[PB3] a missing, extra, renamed or repeated test fails it', () => {
  const missing = compareSuite(
    'db',
    report(base),
    report({
      [BOUNCED]: [
        ['A', 'passed'],
        ['C', 'skipped'],
      ],
    }),
  );
  assert.match(missing.problems.join('\n'), /B ran 1× directly, 0× through PgBouncer/);
  const extra = compareSuite(
    'db',
    report(base),
    report({ [BOUNCED]: [...same[BOUNCED], ['D', 'passed']] }),
  );
  assert.match(extra.problems.join('\n'), /D ran 0× directly, 1× through PgBouncer/);
  const repeated = compareSuite(
    'db',
    report(base),
    report({ [BOUNCED]: [...same[BOUNCED], ['A', 'passed']] }),
  );
  assert.match(repeated.problems.join('\n'), /A ran 1× directly, 2× through PgBouncer/);
});

test('[PB3] a different set of skipped tests fails it, both ways', () => {
  const more = compareSuite(
    'db',
    report(base),
    report({
      [BOUNCED]: [
        ['A', 'passed'],
        ['B', 'skipped'],
        ['C', 'skipped'],
      ],
    }),
  );
  assert.match(more.problems.join('\n'), /B is skipped 0× directly, 1× through PgBouncer/);
  const fewer = compareSuite(
    'db',
    report(base),
    report({
      [BOUNCED]: [
        ['A', 'passed'],
        ['B', 'passed'],
        ['C', 'passed'],
      ],
    }),
  );
  assert.match(fewer.problems.join('\n'), /C is skipped 1× directly, 0× through PgBouncer/);
});

test('[PB3] a file that ran on one side only fails it', () => {
  const other = '/w/apps/api/src/x.int.spec.ts';
  const r = compareSuite('db', report({ ...base, [other]: [['X', 'passed']] }), report(same));
  assert.match(
    r.problems.join('\n'),
    /apps\/api\/src\/x\.int\.spec\.ts ran directly but not through PgBouncer/,
  );
});

test('[PB3] an empty run or a missing result file is a failure, never "nothing differs"', () => {
  const empty = compareSuite('db', report(base), report({}));
  assert.match(empty.problems.join('\n'), /the run through PgBouncer has no tests/);
  const r = compareRuns(
    'd',
    'b',
    () => report(base),
    (f) => !f.includes('crypto'),
  );
  assert.equal(r.ok, false);
  assert.equal(r.problems.filter((p) => p.startsWith('crypto: no results')).length, 2);
  assert.deepEqual(SUITES, ['db', 'crypto', 'api']);
});

test('[PB3] a failure in the direct run is reported too (the comparison is only clean when both runs passed)', () => {
  const r = compareSuite(
    'db',
    report({
      [DIRECT]: [
        ['A', 'failed'],
        ['B', 'passed'],
        ['C', 'skipped'],
      ],
    }),
    report({
      [BOUNCED]: [
        ['A', 'failed'],
        ['B', 'passed'],
        ['C', 'skipped'],
      ],
    }),
  );
  assert.match(r.problems.join('\n'), /A failed directly/);
});
