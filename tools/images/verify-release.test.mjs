// Spec 0013 LR9 regression tests for the deploy's verification, with a fake cosign (no keys, no containers).
// Run with `node --test tools/images/verify-release.test.mjs`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROLES } from './release-lib.mjs';
import { verifyRelease } from './verify-release.mjs';

const COMMIT = 'a'.repeat(40);
const D = { api: `sha256:${'1'.repeat(64)}`, web: `sha256:${'2'.repeat(64)}`, unsigned: `sha256:${'3'.repeat(64)}` };

/** A fake registry of signed images: digest → the externalParameters of its signed provenance. */
function fakeCosign(signed) {
  const calls = [];
  const cosign = (args) => {
    calls.push(args);
    const ref = args.at(-1);
    const digest = ref.split('@')[1];
    const entry = signed[digest];
    if (!entry) return { status: 10, stdout: '', stderr: 'error during command execution: no signatures found' };
    if (args[0] === 'verify') return { status: 0, stdout: '[]', stderr: '' };
    const type = args[args.indexOf('--type') + 1];
    if (type === 'spdxjson') return { status: 0, stdout: '{}', stderr: '' };
    const payload = Buffer.from(JSON.stringify({ predicate: { buildDefinition: { externalParameters: entry } } })).toString('base64');
    return { status: 0, stdout: `${JSON.stringify({ payload })}\n`, stderr: '' };
  };
  return { cosign, calls };
}
const prov = (role, over = {}) => ({ role, dockerfile: ROLES[role].dockerfile, commit: COMMIT, rehearsal: false, ...over });
const record = (over = {}) => ({
  commit: COMMIT,
  rehearsal: false,
  images: {
    api: { repo: ROLES.api.repo, dockerfile: ROLES.api.dockerfile, digest: D.api },
    web: { repo: ROLES.web.repo, dockerfile: ROLES.web.dockerfile, digest: D.web },
  },
  ...over,
});
const verify = (rec, signed, opts = {}) => verifyRelease(rec, { pub: '/keys/cosign.pub', commit: COMMIT, cosign: fakeCosign(signed).cosign, ...opts });
const real = { [D.api]: prov('api'), [D.web]: prov('web') };

test('[LR9] a real release with exactly api and web, signed provenance matching the trusted roles, verifies', () => {
  const r = verify(record(), real);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('[LR9] fix 1: a rehearsal is rejected in deploy mode, even when the record JSON is edited to say otherwise', () => {
  const rehearsalSigned = { [D.api]: prov('api', { rehearsal: true }), [D.web]: prov('web', { rehearsal: true }) };
  const edited = record({ rehearsal: false }); // the editable flag lies; the signed provenance doesn't
  const deploy = verify(edited, rehearsalSigned);
  assert.equal(deploy.ok, false);
  assert.match(deploy.problems.join('\n'), /rehearsal/);
  assert.equal(verify(edited, rehearsalSigned, { allowRehearsal: true }).ok, true, 'the release may verify its own rehearsal');
});

test('[LR9] fix 1: provenance that omits the rehearsal flag is not deployable', () => {
  const noFlag = { [D.api]: prov('api', { rehearsal: undefined }), [D.web]: prov('web') };
  const r = verify(record(), noFlag);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /api: .*rehearsal/);
});

test('[LR9] fix 2: a web-only record (no api) is rejected', () => {
  const rec = record();
  delete rec.images.api;
  const r = verify(rec, real);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /no api image/);
});

test('[LR9] fix 2: an extra, unknown role is rejected', () => {
  const rec = record();
  rec.images.worker = { repo: 'univarse-api', dockerfile: ROLES.api.dockerfile, digest: D.api };
  assert.match(verify(rec, real).problems.join('\n'), /unknown image role "worker"/);
});

test('[LR9] fix 2: the web image substituted for the api (both signed) is rejected by the signed role', () => {
  const rec = record();
  rec.images.api = { ...rec.images.api, digest: D.web };
  const r = verify(rec, real);
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /api: signed provenance does not name role api/);
});

test('[LR9] fix 2: editing the record’s dockerfile or repository does not move the trusted values', () => {
  // The record's dockerfile is ignored: verification uses ROLES, so an edit to it neither helps nor hurts.
  const recDf = record();
  recDf.images.api = { ...recDf.images.api, dockerfile: ROLES.web.dockerfile };
  assert.equal(verify(recDf, real).ok, true);
  // A provenance naming the web Dockerfile for the api role is rejected, whatever the record says.
  const wrongDf = { [D.api]: prov('api', { dockerfile: ROLES.web.dockerfile }), [D.web]: prov('web') };
  assert.equal(verify(record(), wrongDf).ok, false);
  // The repository must be the trusted one.
  const recRepo = record();
  recRepo.images.api = { ...recRepo.images.api, repo: ROLES.web.repo };
  assert.match(verify(recRepo, real).problems.join('\n'), /repository "univarse-web" is not the trusted univarse-api/);
});

test('[LR9] an unsigned digest, and a different commit, are rejected', () => {
  const rec = record();
  rec.images.api = { ...rec.images.api, digest: D.unsigned };
  assert.match(verify(rec, real).problems.join('\n'), /no signatures found/);
  assert.match(verify(record({ commit: 'b'.repeat(40) }), real).problems.join('\n'), /is not the expected/);
});
