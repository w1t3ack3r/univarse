// Spec 0017 PB3: the isolation suites pass through PgBouncer, unchanged. Compares the suites' Vitest JSON results
// from the direct run (build-test) with the run through PgBouncer (pgbouncer-isolation), suite by suite:
//   • the same test files and the same tests, by full name (with multiplicity: a repeated name counts each time);
//   • every test passes through PgBouncer, except those skipped in the direct run too;
//   • the same set of skipped tests;
//   • each suite really ran (a suite with no tests, or a missing result file, is a failure, never "nothing differs").
//
//   node tools/pgbouncer/compare.mjs <direct-results-dir> <pgbouncer-results-dir>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUITES = ['db', 'crypto', 'api'];

/** A test file's path, from wherever the run's checkout was: `apps/…` or `packages/…`. */
export function relativeTestFile(name) {
  const m = /(?:^|\/)((?:apps|packages)\/.+)$/.exec(String(name).replace(/\\/g, '/'));
  if (!m) throw new Error(`a test file outside apps/ and packages/: ${name}`);
  return m[1];
}

const outcome = (status) =>
  status === 'passed'
    ? 'passed'
    : ['pending', 'skipped', 'todo', 'disabled'].includes(status)
      ? 'skipped'
      : 'failed';

/** A Vitest JSON report → its files and its tests (`file › full name` → outcomes, one per occurrence). */
export function readReport(report) {
  const files = new Set();
  const tests = new Map();
  for (const f of report.testResults ?? []) {
    const file = relativeTestFile(f.name);
    files.add(file);
    for (const a of f.assertionResults ?? []) {
      const key = `${file} › ${a.fullName}`;
      tests.set(key, [...(tests.get(key) ?? []), outcome(a.status)]);
    }
  }
  return { files, tests };
}

/** One suite's problems: direct vs through PgBouncer. */
export function compareSuite(suite, direct, bounced) {
  const problems = [];
  const d = readReport(direct);
  const b = readReport(bounced);
  const count = (r) => [...r.tests.values()].reduce((n, o) => n + o.length, 0);
  if (count(d) === 0) problems.push(`${suite}: the direct run has no tests`);
  if (count(b) === 0) problems.push(`${suite}: the run through PgBouncer has no tests`);
  for (const f of d.files)
    if (!b.files.has(f)) problems.push(`${suite}: ${f} ran directly but not through PgBouncer`);
  for (const f of b.files)
    if (!d.files.has(f)) problems.push(`${suite}: ${f} ran through PgBouncer but not directly`);
  for (const key of new Set([...d.tests.keys(), ...b.tests.keys()])) {
    const dd = d.tests.get(key) ?? [];
    const bb = b.tests.get(key) ?? [];
    if (dd.length !== bb.length) {
      problems.push(`${suite}: ${key} ran ${dd.length}× directly, ${bb.length}× through PgBouncer`);
      continue;
    }
    const skippedD = dd.filter((o) => o === 'skipped').length;
    const skippedB = bb.filter((o) => o === 'skipped').length;
    if (skippedD !== skippedB)
      problems.push(
        `${suite}: ${key} is skipped ${skippedD}× directly, ${skippedB}× through PgBouncer`,
      );
    if (bb.includes('failed')) problems.push(`${suite}: ${key} failed through PgBouncer`);
    if (dd.includes('failed')) problems.push(`${suite}: ${key} failed directly`);
  }
  const summary = `${suite}: ${b.files.size} files, ${count(b)} tests through PgBouncer (${
    [...b.tests.values()].flat().filter((o) => o === 'passed').length
  } passed, ${[...b.tests.values()].flat().filter((o) => o === 'skipped').length} skipped); ${count(d)} directly`;
  return { problems, summary };
}

/** Every suite's comparison, from the two results directories (`<suite>.json` in each). */
export function compareRuns(
  directDir,
  bouncedDir,
  read = (f) => JSON.parse(readFileSync(f, 'utf8')),
  exists = existsSync,
) {
  const problems = [];
  const summaries = [];
  for (const suite of SUITES) {
    const files = [join(directDir, `${suite}.json`), join(bouncedDir, `${suite}.json`)];
    const missing = files.filter((f) => !exists(f));
    if (missing.length) {
      problems.push(...missing.map((f) => `${suite}: no results at ${f}`));
      continue;
    }
    const r = compareSuite(suite, read(files[0]), read(files[1]));
    problems.push(...r.problems);
    summaries.push(r.summary);
  }
  return { ok: problems.length === 0, problems, summaries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directDir, bouncedDir] = process.argv.slice(2);
  if (!directDir || !bouncedDir) {
    console.error('usage: compare.mjs <direct-results-dir> <pgbouncer-results-dir>');
    process.exit(2);
  }
  const r = compareRuns(directDir, bouncedDir);
  for (const s of r.summaries) console.log(`[pgbouncer-compare] ${s}`);
  for (const p of r.problems) console.error(`[pgbouncer-compare] FAIL: ${p}`);
  if (r.ok)
    console.log(
      '[pgbouncer-compare] PASS: the same files, tests and skips; every test passed through PgBouncer',
    );
  process.exit(r.ok ? 0 : 1);
}
