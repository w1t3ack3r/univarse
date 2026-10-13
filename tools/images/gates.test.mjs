// Spec 0013 CS7/CS9/CS13: the gate commands themselves, with a fake `sh` (no Docker). The CS13 proofs show each gate
// fails for its reason; these tests stop a later edit from quietly weakening a gate's flags, and show the release
// runs the gates only through this module. Run with `node --test tools/images/gates.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { makeGates, samePushed } from './gates.mjs';

function fake(statuses = []) {
  const calls = [];
  const sh = (cmd, args) => {
    calls.push(args);
    return { status: statuses.length ? statuses.shift() : 0, stdout: 'out', stderr: '' };
  };
  return { sh, calls };
}
const trivyArgs = (args) => args.slice(args.findIndex((a) => a.startsWith('aquasec/trivy:')) + 1);

test('[CS7] the vulnerability gate blocks every HIGH/CRITICAL, fixed or not, and fails the run', () => {
  const { sh, calls } = fake([1]);
  const r = makeGates({ work: '/w', sh }).vulnerability('api.tar');
  assert.equal(r.ok, false);
  const a = trivyArgs(calls[0]);
  assert.deepEqual(a.slice(0, 2), ['image', '--no-progress']);
  for (const want of [
    '--scanners vuln',
    '--severity HIGH,CRITICAL',
    '--exit-code 1',
    '--ignorefile .trivyignore.yaml',
    '--input /work/api.tar',
    '--skip-db-update',
  ]) {
    assert.ok(a.join(' ').includes(want), want);
  }
  assert.ok(!a.some((x) => /ignore[-_]unfixed/i.test(x)), 'never ignore-unfixed (ADR-029)');
});

test('[CS7] the secret gate covers files (node_modules included, via its config) and the image config and history', () => {
  const { sh, calls } = fake();
  const g = makeGates({ work: '/w', sh });
  g.secret('api.tar');
  g.secretReport('api.tar', 'r.json');
  const [gate, report] = calls.map((c) => trivyArgs(c).join(' '));
  for (const want of [
    '--scanners secret',
    '--secret-config tools/images/trivy-secret.yaml',
    '--image-config-scanners secret',
    '--exit-code 1',
  ])
    assert.ok(gate.includes(want), want);
  assert.equal(
    report.replace(/ --format json --output \/work\/r\.json --exit-code 0$/, ''),
    gate.replace(/ --exit-code 1$/, ''),
    'the report scans exactly what the gate scans',
  );
  assert.match(
    readFileSync(new URL('./trivy-secret.yaml', import.meta.url), 'utf8'),
    /skip-patterns:\s*\[\]/,
    'node_modules is not skipped',
  );
});

test('[CS7] misconfiguration gates block HIGH/CRITICAL, for the image config and the Dockerfiles', () => {
  const { sh, calls } = fake();
  const g = makeGates({ work: '/w', sh });
  g.misconfiguration('api.tar');
  g.dockerfiles('infra/docker');
  const [img, conf] = calls.map((c) => trivyArgs(c).join(' '));
  for (const want of [
    '--scanners misconfig',
    '--image-config-scanners misconfig',
    '--severity HIGH,CRITICAL',
    '--exit-code 1',
  ])
    assert.ok(img.includes(want), want);
  assert.match(
    conf,
    /^config --severity HIGH,CRITICAL --ignorefile \.trivyignore\.yaml --exit-code 1 infra\/docker$/,
  );
});

test('[CS9] a fresh DB: the old one is removed first, retries are bounded, and failure is reported, never assumed', () => {
  const { sh, calls } = fake([0, 1, 1, 1]);
  const r = makeGates({ work: '/w', sh }).freshDb();
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.deepEqual(trivyArgs(calls[0]), ['clean', '--vuln-db']);
  assert.ok(trivyArgs(calls[1]).includes('--download-db-only'));
  const ok = fake([0, 1, 0]);
  assert.equal(makeGates({ work: '/w', sh: ok.sh }).freshDb().attempts, 2);
});

test('[CS6] a pushed image is accepted only when its config is the gated one', () => {
  assert.equal(samePushed('r', 'sha256:a', 'sha256:a').ok, true);
  assert.match(samePushed('r', 'sha256:b', 'sha256:a').output, /not the gated sha256:a \(CS6\)/);
});

test('[CS13] the release runs every scan and the CS6 checks through gates.mjs, never its own Trivy command', () => {
  const src = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src,
    /'--scanners'|--exit-code|'image', '--input'|trivy-secret\.yaml/,
    'no hand-written scan in release.mjs',
  );
  for (const g of [
    'freshDb()',
    'gates.vulnerability(',
    'gates.secret(',
    'gates.misconfiguration(',
    "gates.dockerfiles('infra/docker')",
    'gates.inspection(',
    'sameImage(',
    'samePushed(',
  ]) {
    assert.ok(src.includes(g), g);
  }
  const canary = readFileSync(new URL('./canary.mjs', import.meta.url), 'utf8');
  assert.match(
    canary,
    /gates\.secret\('canary\.tar'\)/,
    'the canary proof uses the release’s secret gate',
  );
  assert.doesNotMatch(canary, /'--scanners'/);
});
