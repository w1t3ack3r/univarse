// Spec 0013 CS7: the exception rules. Run with `node --test tools/images/exceptions.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exceptionProblems, ignoreUnfixedProblems, parseExceptions } from './exceptions.mjs';

const TODAY = '2026-10-12';
const entry = (over = '') => `vulnerabilities:
  - id: CVE-2026-0001
    purls:
      - pkg:npm/example@1.0.0
    statement: not reachable; the vulnerable parser is never called
    owner: samuel
    expired_at: 2026-10-30
${over}secrets: []
misconfigurations: []
`;

test('[CS7] an empty file has no exceptions and no problems', () => {
  const p = parseExceptions('vulnerabilities: []\nsecrets: []\nmisconfigurations: []\n');
  assert.deepEqual(p, { vulnerabilities: [], secrets: [], misconfigurations: [] });
  assert.deepEqual(exceptionProblems(p, TODAY), []);
});

test('[CS7] a complete, in-date exception passes and is parsed exactly', () => {
  const p = parseExceptions(entry());
  assert.deepEqual(p.vulnerabilities[0], { id: 'CVE-2026-0001', purls: ['pkg:npm/example@1.0.0'], statement: 'not reachable; the vulnerable parser is never called', owner: 'samuel', expired_at: '2026-10-30' });
  assert.deepEqual(exceptionProblems(p, TODAY), []);
});

test('[CS7] missing evidence, owner or package, an expired entry, and one too far ahead all fail', () => {
  const missing = parseExceptions('vulnerabilities:\n  - id: CVE-2026-0002\n    expired_at: 2026-10-20\nsecrets: []\nmisconfigurations: []\n');
  const probs = exceptionProblems(missing, TODAY).join('\n');
  for (const k of ['missing statement', 'missing owner', 'missing purls']) assert.match(probs, new RegExp(k));
  assert.match(exceptionProblems(parseExceptions(entry().replace('2026-10-30', '2026-10-01')), TODAY).join(), /expired on 2026-10-01/);
  assert.match(exceptionProblems(parseExceptions(entry().replace('2026-10-30', '2026-12-30')), TODAY).join(), /more than 30 days ahead/);
});

test('[CS7] a secret exception must name exact paths', () => {
  const p = parseExceptions('vulnerabilities: []\nsecrets:\n  - id: generic-api-key\n    statement: x\n    owner: y\n    expired_at: 2026-10-20\nmisconfigurations: []\n');
  assert.match(exceptionProblems(p, TODAY).join(), /missing paths/);
});

test('[CS7] ignore-unfixed anywhere fails; a comment mentioning it does not', () => {
  assert.equal(ignoreUnfixedProblems([{ path: 'ci.yml', text: '# we never use ignore-unfixed\nrun: trivy image x' }]).length, 0);
  assert.equal(ignoreUnfixedProblems([{ path: 'ci.yml', text: 'run: trivy image --ignore-unfixed x' }]).length, 1);
  assert.equal(ignoreUnfixedProblems([{ path: 'trivy.yaml', text: 'vulnerability:\n  ignore-unfixed: true' }]).length, 1);
});
