// The OA12 gate's own tests (node --test tools/api-contract): it must reject every unacknowledged break.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ackSection, evaluate, summary } from './check-breaking.mjs';

// Shaped like oasdiff 1.33 `breaking --format json`, from this repo's history: step 3 newly DOCUMENTED
// If-Match as required on settings writes. The API already enforced it at run time (428), so oasdiff
// reports a contract break although no running client's behaviour changed.
const PUT = { id: 'new-required-request-parameter', text: 'added the new required `header` request parameter `if-match`', level: 3, operation: 'PUT', path: '/api/v1/settings/{key}' };
const DEL = { ...PUT, operation: 'DELETE' };
const WARNING = { id: 'response-optional-property-removed', text: 'removed the optional property `hint`', level: 2, operation: 'GET', path: '/api/v1/files' };
const TABS = 'Open tabs: the web app already sends If-Match on every settings write, so tabs opened before this release keep working.';
const body = (section) => `## Summary\nSomething.\n\n${section}\n\n## Testing\nDone.\n`;

describe('[OA12] the acknowledgement gate', () => {
  it('[OA12] no breaking changes: passes with any description, warnings are only reported', () => {
    assert.equal(evaluate([], '').ok, true);
    const r = evaluate([WARNING], '');
    assert.deepEqual([r.ok, r.warnings.length], [true, 1]);
    assert.match(summary(r), /warning \| `GET \/api\/v1\/files`/);
  });

  it('[OA12] an unacknowledged break fails: no section at all', () => {
    const r = evaluate([PUT, DEL], body(''));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /2 breaking change\(s\), but the PR description has no "## API breaking changes" section/);
    assert.match(summary(r), /Verdict: unacknowledged/);
  });

  it('[OA12] a section that does not name every broken operation fails, naming what is missing', () => {
    const r = evaluate([PUT, DEL], body(`## API breaking changes\n- \`PUT /api/v1/settings/{key}\`: If-Match is now documented as required.\n${TABS}`));
    assert.deepEqual(r.problems, ['Not named in "## API breaking changes": DELETE /api/v1/settings/{key}.']);
  });

  it('[OA12] the open-tabs explanation is required, and a placeholder or TODO does not count', () => {
    const named = '## API breaking changes\n- PUT /api/v1/settings/{key} and DELETE /api/v1/settings/{key}: If-Match required.';
    for (const tabs of ['', 'Open tabs:', 'Open tabs: <how do open tabs cope?>', 'Open tabs: TODO later on, honestly', 'Open tabs: fine']) {
      const r = evaluate([PUT, DEL], body(`${named}\n${tabs}`));
      assert.equal(r.ok, false, `accepted: ${JSON.stringify(tabs)}`);
      assert.match(r.problems.at(-1), /Open tabs:/);
    }
  });

  it('[OA12] a complete acknowledgement passes (backticks, list markers and case are tolerated)', () => {
    const r = evaluate([PUT, DEL], body(`## API Breaking Changes\n- \`put /api/v1/settings/{key}\`, \`DELETE /api/v1/settings/{key}\`: If-Match required.\n- ${TABS}`));
    assert.deepEqual([r.ok, r.problems], [true, []]);
    assert.match(summary(r), /2 breaking change\(s\), acknowledged/);
  });

  it('[OA12] the PR template’s commented-out example never acknowledges a break', () => {
    const template = readFileSync(new URL('../../.github/pull_request_template.md', import.meta.url), 'utf8');
    assert.match(template, /## API breaking changes/); // the example is there, naming PUT /api/v1/settings/{key}…
    const r = evaluate([PUT], template); // …but inside a comment, so it doesn't count
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /no "## API breaking changes" section/);
  });

  it('[OA12] only the acknowledgement section counts: naming the operation elsewhere is not enough', () => {
    const r = evaluate([PUT], `## Summary\nPUT /api/v1/settings/{key} changed. ${TABS}\n\n## API breaking changes\nSee above.\n`);
    assert.equal(r.ok, false);
    assert.equal(ackSection('## API breaking changes\nA\n## Next\nB'), 'A');
  });
});
