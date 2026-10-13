// Spec 0013 CS12/CS13: the workflow policy rejects each fixture for its intended reason, and only that reason,
// and the real workflows (the positive control) pass. Read-only: parses files, runs nothing.
// Run with `node --test tools/ci-policy/`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  dirProblems,
  effectiveShell,
  fileProblems,
  permissionProblems,
  shellCommand,
  triggersOf,
} from './workflow-policy.mjs';

const fixture = (name) =>
  fileProblems(readFileSync(new URL(`./fixtures/${name}.yml`, import.meta.url), 'utf8'), name);

/** Every problem matches one expected pattern, and every pattern is matched: nothing incidental. */
function rejectedExactly(name, expected) {
  const problems = fixture(name);
  assert.ok(problems.length > 0, `${name} must be rejected`);
  for (const p of problems)
    assert.ok(
      expected.some((re) => re.test(p)),
      `${name}: unexpected problem: ${p}`,
    );
  for (const re of expected)
    assert.ok(
      problems.some((p) => re.test(p)),
      `${name}: expected ${re}, got:\n${problems.join('\n')}`,
    );
}

test('[CS12] positive control: the real workflows comply', () => {
  assert.deepEqual(
    dirProblems(
      new URL('../../.github/workflows', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    ),
    [],
  );
});

test('[CS12] a pull_request job requesting id-token, packages or attestations write is rejected', () => {
  rejectedExactly('pr-id-token-write', [
    /job build permissions request id-token: write \(publish\/sign\/attest\)/,
  ]);
  rejectedExactly('pr-packages-write', [
    /workflow permissions request packages: write \(publish\/sign\/attest\)/,
  ]);
  rejectedExactly('pr-attestations-write', [
    /job build permissions request attestations: write \(publish\/sign\/attest\)/,
  ]);
});

test('[CS12] pull_request_target checking out the PR head is rejected, and the trigger itself is banned', () => {
  rejectedExactly('prt-checkout-head', [
    /uses the privileged trigger pull_request_target/,
    /checks out the PR's head under pull_request_target/,
  ]);
  rejectedExactly('prt-no-checkout', [/uses the privileged trigger pull_request_target/]);
});

test('[CS12] workflow_run running PR-supplied code is rejected', () => {
  rejectedExactly('workflow-run-pr-code', [
    /uses the privileged trigger workflow_run/,
    /downloads another run's artifacts under workflow_run/,
    /runs PR-supplied code under workflow_run/,
  ]);
});

test('[CS12] a PR-reachable job referencing the publish credentials, or publishing, is rejected', () => {
  rejectedExactly('pr-publish-credentials', [
    /references the credential secrets\.COSIGN_PASSWORD/,
    /references the credential secrets\.REGISTRY_TOKEN/,
    /runs docker login in a PR-reachable workflow/,
    /runs docker push in a PR-reachable workflow/,
    /runs cosign sign\/attest\/copy in a PR-reachable workflow/,
  ]);
});

test('[CS12] fail closed: undeclared or blanket permissions, and unpinned actions, are rejected', () => {
  rejectedExactly('no-permissions', [/declares no workflow-level permissions/]);
  rejectedExactly('write-all', [/workflow permissions are write-all/]);
  rejectedExactly('unpinned-action', [
    /uses actions\/checkout@v4, not pinned/,
    /without persist-credentials: false/,
  ]);
});

test('[CS12] rules in isolation: trigger forms, unknown triggers and permission levels', () => {
  assert.deepEqual(triggersOf({ on: 'push' }), ['push']);
  assert.deepEqual(triggersOf({ on: ['push', 'pull_request'] }), ['push', 'pull_request']);
  assert.deepEqual(triggersOf({ on: { push: { branches: ['main'] } } }), ['push']);
  assert.match(
    fileProblems(
      'on: release\npermissions: {contents: read}\njobs: {a: {runs-on: x, steps: []}}',
      'w',
    ).join(),
    /trigger release is not on the allowlist/,
  );
  assert.match(
    fileProblems('on: [issue_comment]\npermissions: {}\njobs: {a: {runs-on: x}}', 'w').join(),
    /privileged trigger issue_comment/,
  );
  assert.deepEqual(permissionProblems({ contents: 'read', 'pull-requests': 'none' }, 'p'), []);
  assert.match(
    permissionProblems({ statuses: 'write' }, 'p').join(),
    /statuses: write \(CI is read-only\)/,
  );
  assert.match(permissionProblems({ contents: 'admin' }, 'p').join(), /unknown level/);
  assert.match(fileProblems('on: [push\n', 'w').join(), /does not parse/);
});

test('[CS12] every run step needs bash with pipefail: the default shell and sh are rejected', () => {
  rejectedExactly('pipe-default-shell', [
    /runs under GitHub's default shell \(bash -e, no pipefail\)/,
  ]);
  rejectedExactly('step-shell-sh', [/runs under shell "sh"/]);
});

/** Runs the line of a real ci.yml step that holds `command`, the way GitHub would, with `command` failing. */
function runStep(stepMatch, command, { shellOverride } = {}) {
  const wf = yaml.load(
    readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );
  for (const job of Object.values(wf.jobs)) {
    const step = (job.steps ?? []).find(
      (st) => typeof st.run === 'string' && st.run.includes(stepMatch),
    );
    if (!step) continue;
    assert.ok(step.run.includes(command), `the step runs ${command}`);
    const shell = shellOverride === undefined ? effectiveShell(wf, job, step) : shellOverride.value;
    const dir = mkdtempSync(join(tmpdir(), 'uv-step-'));
    const script = join(dir, 'step.sh');
    // Exactly the step's line that runs the command (other lines, e.g. downloads, would fail for other reasons).
    const line = step.run.split('\n').find((l) => l.includes(command));
    writeFileSync(script, `${line.replace(command, 'node -e "process.exit(3)"')}\n`);
    const [cmd, ...args] = shellCommand(shell);
    return spawnSync(cmd, [...args, script], {
      env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, 'summary') },
      encoding: 'utf8',
    });
  }
  throw new Error(`no ci.yml step runs ${stepMatch}`);
}

test('[CS13] a failing gate-proof run, or exceptions check, fails its CI step as configured; the default shell would hide it', () => {
  for (const [match, command] of [
    ['tools/images/gate-proofs.mjs', 'node tools/images/gate-proofs.mjs'],
    ['node tools/images/exceptions.mjs |', 'node tools/images/exceptions.mjs'],
  ]) {
    const configured = runStep(match, command);
    assert.notEqual(
      configured.status,
      0,
      `${command}: the configured step must fail (${configured.stderr})`,
    );
    const unprotected = runStep(match, command, { shellOverride: { value: undefined } });
    assert.equal(
      unprotected.status,
      0,
      `${command}: under bash -e the pipe would mask the failure (the test can tell the difference)`,
    );
  }
});
