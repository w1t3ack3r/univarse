// Spec 0024: the gates' own logic, without the scanners (node --test tools/security/security.test.mjs). CI's proof steps
// then run each scanner on its fixture (tools/security/fixtures/), so both halves are shown: the decision, and that
// the scanner really produces what is decided on.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeqlFilterProblems, inlineProblems, licenseExceptionProblems, osvProblems, parseOsvConfig } from './exceptions.mjs';
import { checkovGate, codeqlGate, decide, osvGate, semgrepGate } from './gates.mjs';
import { ALLOWED, licenseReport, rowsOf, spdxAllowed } from './licenses.mjs';
import { titleProblem, TYPES } from './pr-title.mjs';

const TODAY = '2026-10-26';

describe('[G6] licenses', () => {
  it('reads SPDX expressions: AND needs both, OR either, parentheses group, operators in any case', () => {
    assert.equal(spdxAllowed('MIT'), true);
    assert.equal(spdxAllowed('MIT and ISC'), true);
    assert.equal(spdxAllowed('(MIT OR CC0-1.0)'), true);
    assert.equal(spdxAllowed('MIT OR AGPL-3.0-only'), true);
    assert.equal(spdxAllowed('Apache-2.0 AND LGPL-3.0-or-later'), false);
    assert.equal(spdxAllowed('(MIT AND (ISC OR GPL-2.0))'), true);
    assert.equal(spdxAllowed('GPL-2.0 OR (AGPL-3.0 AND MIT)'), false);
  });

  it('refuses the unknown, the malformed and the empty', () => {
    for (const x of ['', 'Unknown', 'UNLICENSED', 'MIT AND', '(MIT', 'MIT)', 'AND MIT', 'SEE LICENSE IN LICENSE.md']) assert.equal(spdxAllowed(x), false, x);
  });

  it('allows exactly the approved list, MIT-0 added', () => {
    assert.deepEqual(ALLOWED, ['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib']);
    for (const x of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-3.0', 'SSPL-1.0', 'BUSL-1.1', 'EPL-2.0', 'MPL-2.0', 'CC-BY-4.0']) assert.equal(spdxAllowed(x), false, x);
  });

  it('a production package outside the list blocks unless an exception names it AND its license; development is reported', () => {
    const prod = rowsOf({ MIT: [{ name: 'a', versions: ['1'] }], 'EPL-2.0': [{ name: 'elkjs', versions: ['0.11.1'] }], 'AGPL-3.0-only': [{ name: 'bad', versions: ['2'] }] });
    const dev = rowsOf({ 'MPL-2.0': [{ name: 'axe-core', versions: ['4'] }] });
    const ex = [{ id: 'LIC-elkjs', packages: ['elkjs'], licenses: ['EPL-2.0'], expired_at: '2027-10-26' }];
    const r = licenseReport(prod, dev, ex);
    assert.deepEqual(r.problems, ['bad@2: AGPL-3.0-only is not on the allowlist (spec 0024 G6), and no exception covers it']);
    assert.equal(r.excepted.length, 1);
    assert.deepEqual(r.dev, ['axe-core@4 (MPL-2.0)']);
    // The exception covers elkjs under EPL-2.0 only: a relicensed elkjs blocks again.
    assert.equal(licenseReport(rowsOf({ 'GPL-3.0': [{ name: 'elkjs', versions: ['1'] }] }), [], ex).problems.length, 1);
  });
});

describe('[G4] exceptions', () => {
  it('an osv exception needs an id, a reason and an expiry within 30 days', () => {
    const parsed = parseOsvConfig('[[IgnoredVulns]]\nid = "GHSA-1"\nignoreUntil = 2026-11-20\nreason = "fixed upstream next week, not reachable here"\n');
    assert.deepEqual(osvProblems(parsed, TODAY).problems, []);
    assert.match(osvProblems([{ id: 'X', reason: 'a long enough reason', ignoreUntil: '2026-12-31' }], TODAY).problems.join(), /more than 30 days ahead/);
    assert.match(osvProblems([{ id: 'X', reason: 'a long enough reason', ignoreUntil: '2026-10-25' }], TODAY).problems.join(), /expired on 2026-10-25/);
    assert.match(osvProblems([{ id: 'X', ignoreUntil: '2026-11-01' }], TODAY).problems.join(), /no reason/);
    assert.match(osvProblems([{ reason: 'a long enough reason', ignoreUntil: '2026-11-01' }], TODAY).problems.join(), /no id/);
    assert.match(osvProblems([{ id: 'X', reason: 'a long enough reason' }], TODAY).problems.join(), /no expiry/);
  });

  it('a license exception needs every field, an expiry within 365 days, and a unique id', () => {
    const ok = { id: 'L', packages: ['p'], licenses: ['EPL-2.0'], statement: 'evidence enough to read', owner: 'samuel', expired_at: '2027-10-26' };
    assert.deepEqual(licenseExceptionProblems([ok], TODAY).problems, []);
    assert.match(licenseExceptionProblems([{ ...ok, expired_at: '2027-10-27' }], TODAY).problems.join(), /more than 365 days/);
    for (const k of ['id', 'statement', 'owner', 'packages', 'licenses']) {
      const { [k]: _omit, ...rest } = ok;
      assert.match(licenseExceptionProblems([rest], TODAY).problems.join(), new RegExp(`missing ${k}`), k);
    }
    assert.match(licenseExceptionProblems([ok, ok], TODAY).problems.join(), /duplicate id/);
  });

  it('inline suppressions name their rule and give a reason; a bare one, or one without a reason, fails', () => {
    assert.deepEqual(inlineProblems('x(); // nosemgrep: some.rule-id -- a reason that is long enough', 'a.ts').problems, []);
    assert.match(inlineProblems('x(); // nosemgrep', 'a.ts').problems.join(), /must name its rule/);
    assert.match(inlineProblems('x(); // nosem', 'a.ts').problems.join(), /must name its rule/);
    assert.match(inlineProblems('x(); // NOSEMGREP', 'a.ts').problems.join(), /must name its rule/);
    assert.match(inlineProblems('x(); // nosemgrep: some.rule', 'a.ts').problems.join(), /must name its rule and give a reason/);
    assert.match(inlineProblems('x(); // nosemgrep: r -- short', 'a.ts').problems.join(), /too short/);
    assert.deepEqual(inlineProblems('# checkov:skip=CKV_DOCKER_2: distroless, checked from outside', 'Dockerfile').problems, []);
    assert.match(inlineProblems('# checkov:skip=CKV_DOCKER_2', 'Dockerfile').problems.join(), /has no reason/);
    assert.match(inlineProblems('# checkov:skip=all: everything at once please', 'Dockerfile').problems.join(), /must name one check/);
    assert.equal(inlineProblems('# checkov:skip=CKV_DOCKER_2: distroless, checked from outside', 'Dockerfile').active.length, 1);
  });

  it("a CodeQL query-filters exclude needs a reason on the line above", () => {
    assert.deepEqual(codeqlFilterProblems('query-filters:\n  # reason: a false positive in generated code\n  - exclude:\n      id: js/x\n', 'c.yml').problems, []);
    assert.match(codeqlFilterProblems('query-filters:\n  - exclude:\n      id: js/x\n', 'c.yml').problems.join(), /needs a "# reason/);
  });
});

describe('[G3][G8] the gates', () => {
  it('Semgrep: ERROR blocks; WARNING and scan errors are reported', () => {
    const g = semgrepGate({
      results: [
        { check_id: 'a.b.gcm-no-tag-length', path: 'x.ts', start: { line: 3 }, extra: { severity: 'ERROR', message: 'm' } },
        { check_id: 'a.b.style', path: 'y.ts', start: { line: 1 }, extra: { severity: 'WARNING', message: 'm' } },
      ],
      errors: [{ level: 'warn', path: 'z.yml', message: 'partial parse' }],
      paths: { scanned: ['x.ts', 'y.ts', 'z.yml'] },
    });
    assert.equal(g.blocking.length, 1);
    assert.equal(g.reported.length, 2);
    assert.equal(decide('semgrep', g).ok, false);
    assert.equal(decide('semgrep', semgrepGate({ results: [], errors: [] })).ok, true);
  });

  it('osv: any vulnerability blocks', () => {
    const g = osvGate({ results: [{ packages: [{ package: { name: 'lodash', version: '4.17.20' }, vulnerabilities: [{ id: 'GHSA-35jh-r3h4-6jhm', summary: 's' }] }] }] });
    assert.deepEqual(g.blocking.map((b) => b.id), ['GHSA-35jh-r3h4-6jhm']);
    assert.equal(decide('osv', osvGate({ results: [] })).ok, true);
  });

  it('Checkov: failed checks block; skipped ones are reported with their reason', () => {
    const g = checkovGate([
      { results: { failed_checks: [{ check_id: 'CKV_GHA_2', file_path: '/w.yml', file_line_range: [11, 13], check_name: 'injection' }], skipped_checks: [] } },
      { results: { failed_checks: [], skipped_checks: [{ check_id: 'CKV_DOCKER_2', file_path: '/D', check_result: { suppress_comment: 'distroless' } }] } },
    ]);
    assert.deepEqual(g.blocking.map((b) => b.id), ['CKV_GHA_2']);
    assert.equal(g.reported[0]?.what, 'distroless');
  });

  it("Checkov --quiet: the summary's unlisted failures and parse errors block; its skips are reported by count", () => {
    const quiet = (summary) => checkovGate([{ check_type: 'dockerfile', results: { failed_checks: [] }, summary }]);
    assert.deepEqual(quiet({ passed: 395, failed: 0, skipped: 8, parsing_errors: 0 }).blocking, []);
    assert.match(quiet({ passed: 395, failed: 0, skipped: 8, parsing_errors: 0 }).reported[0]?.what ?? '', /8 checks skipped/);
    assert.deepEqual(quiet({ failed: 2, skipped: 0, parsing_errors: 0 }).blocking.map((b) => b.id), ['dockerfile failed']);
    assert.deepEqual(quiet({ failed: 0, skipped: 0, parsing_errors: 1 }).blocking.map((b) => b.id), ['dockerfile parsing errors']);
  });

  it("CodeQL: error and warning block, note is reported; a result without a level takes its rule's", () => {
    const sarif = {
      runs: [
        {
          tool: { driver: { rules: [{ id: 'js/command-line-injection', defaultConfiguration: { level: 'error' } }, { id: 'js/note', defaultConfiguration: { level: 'note' } }] } },
          results: [
            { ruleId: 'js/command-line-injection', message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri: 's.js' }, region: { startLine: 9 } } }] },
            { ruleId: 'js/note', message: { text: 'n' } },
            { ruleId: 'js/w', level: 'warning', message: { text: 'w' } },
          ],
        },
      ],
    };
    const g = codeqlGate(sarif);
    assert.deepEqual(g.blocking.map((b) => b.id), ['js/command-line-injection', 'js/w']);
    assert.deepEqual(g.reported.map((r) => r.id), ['js/note']);
  });

  it('a proof passes only when the gate blocks for the expected finding: not on a pass, not for another finding', () => {
    const one = osvGate({ results: [{ packages: [{ package: { name: 'p', version: '1' }, vulnerabilities: [{ id: 'GHSA-1' }] }] }] });
    assert.equal(decide('osv', one, 'GHSA-1').ok, true);
    assert.equal(decide('osv', one, 'GHSA-2').ok, false);
    assert.equal(decide('osv', osvGate({ results: [] }), 'GHSA-1').ok, false);
  });
});

describe('[G10] the PR title', () => {
  it('accepts type(scope): description, with the known types', () => {
    for (const t of TYPES) assert.equal(titleProblem(`${t}(stack): something`), null, t);
    assert.equal(titleProblem('feat(api-client)!: a breaking change'), null);
  });

  it('refuses a missing type, an unknown type, a missing or uppercase scope, and a missing description', () => {
    assert.match(titleProblem('update stuff') ?? '', /does not start with a type/);
    assert.match(titleProblem('feature(stack): x') ?? '', /"feature" is not a type/);
    assert.match(titleProblem('feat: no scope') ?? '', /scope is missing/);
    assert.match(titleProblem('feat(Stack): x') ?? '', /lowercase/);
    assert.match(titleProblem('feat(stack):') ?? '', /description/);
    assert.match(titleProblem('') ?? '', /empty/);
  });
});
