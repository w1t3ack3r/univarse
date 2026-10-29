// Spec 0026 SB6: the proof's judgement. Each way a proof run can be wrong must be reported, and only the right
// failure passes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failures, problems } from './a11y-proof-lib.mjs';

const result = (title, status, message = '') => ({ title, status, failureMessages: message ? [message] : [] });
const report = (...results) => ({ testResults: [{ assertionResults: results }] });
const RIGHT = report(
  result('Lime Text On Off White', 'failed', 'Elements must meet minimum color contrast ratio thresholds (color-contrast)'),
  result('Icon Button Without Name', 'failed', 'Buttons must have discernible text (button-name)'),
);

test('the right failures pass', () => {
  assert.deepEqual(problems(1, failures(RIGHT)), []);
});

test('a proof that passed is reported', () => {
  const passed = report(result('Lime Text On Off White', 'passed'), result('Icon Button Without Name', 'passed'));
  const p = problems(0, failures(passed));
  assert.ok(p.some((l) => /proof passed/.test(l)));
  assert.ok(p.some((l) => /LimeTextOnOffWhite: passed, not failed/.test(l)));
});

test('a failure for another reason is reported', () => {
  const wrong = report(
    result('Lime Text On Off White', 'failed', 'TypeError: cannot read properties of undefined'),
    result('Icon Button Without Name', 'failed', 'Buttons must have discernible text (button-name)'),
  );
  assert.deepEqual(problems(1, failures(wrong)), ['LimeTextOnOffWhite: failed, but not for color-contrast (found: no rule)']);
});

test('each story must fail for its own rule, not the other one', () => {
  const swapped = report(
    result('Lime Text On Off White', 'failed', '(button-name)'),
    result('Icon Button Without Name', 'failed', '(color-contrast)'),
  );
  assert.equal(problems(1, failures(swapped)).length, 2);
});

test('a missing story and an unexpected one are reported', () => {
  const p = problems(1, failures(report(result('Lime Text On Off White', 'failed', '(color-contrast)'), result('Something Else', 'failed', '(region)'))));
  assert.ok(p.includes('IconButtonWithoutName: not run'));
  assert.ok(p.some((l) => /unexpected proof stories: SomethingElse/.test(l)));
});
