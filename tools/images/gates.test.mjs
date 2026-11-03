// Spec 0013 CS7/CS9/CS13: the gate commands themselves, with a fake `sh` (no Docker). The CS13 proofs show each gate
// fails for its reason; these tests stop a later edit from quietly weakening a gate's flags, and show the release
// runs the gates only through this module. Run with `node --test tools/images/gates.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DB_REUSE, makeGates, reusableDb, samePushed } from './gates.mjs';

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
    'freshDb(',
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

test('[CS9] if the old DB can not be removed, nothing is downloaded and the release scans nothing', () => {
  const { sh, calls } = fake([1, 0, 0]); // cleanup fails; a download WOULD succeed
  const r = makeGates({ work: '/w', sh }).freshDb();
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 0);
  assert.match(r.why, /could not remove the old vulnerability database/);
  assert.equal(calls.length, 1, 'only the cleanup ran: no download');
  assert.deepEqual(trivyArgs(calls[0]), ['clean', '--vuln-db']);
  // The release stops on any freshDb failure, before its first scan.
  const src = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const stop = src.indexOf('if (!db0.ok) throw new Error(');
  for (const scan of [
    'gates.vulnerabilityReport(',
    'gates.vulnerability(',
    'gates.secret(',
    'gates.misconfiguration(',
    'gates.sbom(',
  ]) {
    assert.ok(stop > 0 && stop < src.indexOf(scan), `the release throws before ${scan}`);
  }
});

test('[CS9] a cached DB is reused only when downloaded in the last 6 h and built in the last day; anything else downloads', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  assert.equal(reusableDb({ downloadedAt: at(1), updatedAt: at(5) }, now).ok, true);
  assert.equal(reusableDb({ downloadedAt: at(5.9), updatedAt: at(23) }, now).ok, true);
  assert.match(reusableDb({ downloadedAt: at(6.1), updatedAt: at(1) }, now).why, /downloaded 6\.1 h ago, over 6\.0 h/);
  assert.match(reusableDb({ downloadedAt: at(1), updatedAt: at(25) }, now).why, /built 25\.0 h ago, over 24\.0 h/);
  assert.match(reusableDb({ downloadedAt: at(-2), updatedAt: at(1) }, now).why, /in the future/);
  for (const meta of [null, {}, { downloadedAt: 'not a date', updatedAt: at(1) }, { downloadedAt: at(1), updatedAt: null }])
    assert.match(reusableDb(meta, now).why, /no readable vulnerability database/);
  assert.deepEqual(DB_REUSE, { maxDownloadAgeMs: 6 * 3_600_000, maxBuiltAgeMs: 24 * 3_600_000 });
});

test("[CS9] the cached DB's dates come from `trivy version`; an unreadable answer means none", () => {
  const sh = (cmd, args) => ({ status: 0, stdout: JSON.stringify({ VulnerabilityDB: { UpdatedAt: '2026-11-03T06:00:00Z', DownloadedAt: '2026-11-03T10:00:00Z' } }), stderr: '', args });
  assert.deepEqual(makeGates({ work: '/w', sh }).dbMeta(), { updatedAt: '2026-11-03T06:00:00Z', downloadedAt: '2026-11-03T10:00:00Z' });
  assert.equal(makeGates({ work: '/w', sh: () => ({ status: 1, stdout: '', stderr: 'boom' }) }).dbMeta(), null);
  assert.equal(makeGates({ work: '/w', sh: () => ({ status: 0, stdout: 'not json', stderr: '' }) }).dbMeta(), null);
});

test("[CS9] the release's download is live: Trivy's own output reaches the terminal, with its progress bar", () => {
  const calls = [];
  const sh = (cmd, args, opts) => {
    calls.push({ args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  makeGates({ work: '/w', sh }).freshDb({ progress: true });
  const download = calls.find((c) => c.args.includes('--download-db-only'));
  assert.equal(download.opts.stdio, 'inherit');
  assert.ok(!download.args.includes('--no-progress'));
  // The proofs keep capturing, to check why a gate failed.
  calls.length = 0;
  makeGates({ work: '/w', sh }).freshDb();
  assert.ok(calls.find((c) => c.args.includes('--download-db-only')).args.includes('--no-progress'));
});

test('[CS9] the release decides on reuse before downloading, and still throws before any scan if the download fails', () => {
  const src = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const decide = src.indexOf('reusableDb(gates.dbMeta())');
  const download = src.indexOf('gates.freshDb({ progress: true })');
  assert.ok(decide > 0 && decide < download, 'reuse is decided first');
  assert.ok(download < src.indexOf('if (!db0.ok) throw new Error('));
  assert.match(src, /dbSource/, 'the record says which');
});
