// Spec 0041 Q10: the type-branching rule's own tests (node --test tools/lint). The selectors catch a comparison or a
// `switch` case on a type literal and nothing else; the workspace's real config applies them where it should and
// leaves the permitted places alone.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { TYPE_BRANCHING_RESTRICTIONS } from './type-branching.mjs';

const linter = new Linter({ configType: 'flat' });
const lint = (code) =>
  linter.verify(code, [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, rules: { 'no-restricted-syntax': ['error', ...TYPE_BRANCHING_RESTRICTIONS] } }], 'x.ts');

describe('[Q10] the selectors', () => {
  it('refuse a comparison with a type literal, either way round, strict or loose, equal or not', () => {
    for (const code of [
      "if (t.type === 'POLYTECHNIC') run();",
      "if ('UNIVERSITY' === t.type) run();",
      "const x = t.type !== 'COLLEGE_OF_EDUCATION';",
      "const y = t.type == 'UNIVERSITY';",
    ]) {
      const m = lint(code);
      assert.equal(m.length, 1, code);
      assert.match(m[0].message, /ADR-039/);
    }
  });

  it('refuse a switch case on a type literal', () => {
    assert.equal(lint("switch (t.type) { case 'POLYTECHNIC': break; default: break; }").length, 1);
  });

  it('leave data, types and other strings alone', () => {
    for (const code of [
      "const regulators = { UNIVERSITY: 'NUC', POLYTECHNIC: 'NBTE' };",
      "type T = 'UNIVERSITY' | 'POLYTECHNIC';",
      "const types = ['UNIVERSITY', 'POLYTECHNIC', 'COLLEGE_OF_EDUCATION'];",
      "if (q.family === 'nd') run();",
      "if (t.type === profile.type) run();",
      "if (status === 'ACTIVE') run();",
      "switch (q.family) { case 'nce': break; default: break; }",
    ]) {
      assert.deepEqual(lint(code), [], code);
    }
  });
});

describe('[Q10] the workspace config', () => {
  const eslint = new ESLint({ cwd: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  const ruleFor = async (path) => (await eslint.calculateConfigForFile(path)).rules?.['no-restricted-syntax'];
  const restricts = (rule) => Array.isArray(rule) && TYPE_BRANCHING_RESTRICTIONS.every((r) => rule.some((x) => typeof x === 'object' && x.selector === r.selector));

  it('applies to application and domain logic, the web app included (its own block keeps it)', async () => {
    for (const path of ['apps/api/src/modules/profiles/profile-pass.ts', 'packages/domain/src/results/gpa.ts', 'apps/console/src/app/institutions/labels.ts', 'apps/web/src/app/layout.tsx']) {
      assert.equal(restricts(await ruleFor(path)), true, path);
    }
    // The web app's own restriction survives beside it.
    assert.equal((await ruleFor('apps/web/src/app/layout.tsx')).some((x) => typeof x === 'object' && /api\.v1/.test(x.selector)), true);
  });

  it('leaves the profile definitions, provisioning’s selection, tests and migration tooling alone', async () => {
    for (const path of ['packages/domain/src/platform/provisioning.ts', 'packages/domain/src/platform/profiles.ts', 'packages/db-ops/src/seed.ts', 'apps/api/src/modules/profiles/profile-pass.int.spec.ts']) {
      assert.equal(restricts(await ruleFor(path)), false, path);
    }
  });
});
