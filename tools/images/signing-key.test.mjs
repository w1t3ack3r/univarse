// LR5 precondition (release-lib signingKeyProblem): the release refuses a wrong password, or a key that isn't the
// committed public key's, before building anything. Real cosign in its pinned container, with throwaway keys made
// here (never the owner's). Needs Docker. `node --test tools/images/signing-key.test.mjs`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { COSIGN_IMAGE, hostPath, pemBody, sh, signingKeyProblem } from './release-lib.mjs';

const PASSWORD = 'throwaway-test-password-0001';
let dir;
const pair = (name, password) => {
  const d = join(dir, name);
  mkdirSync(d);
  // The cosign image has no shell: it writes cosign.key and cosign.pub into its working directory.
  sh('docker', ['run', '--rm', '--network', 'none', '-e', 'COSIGN_PASSWORD', '-v', `${hostPath(d)}:/k`, '-w', '/k', COSIGN_IMAGE, 'generate-key-pair'], { env: { COSIGN_PASSWORD: password } });
  return { key: join(d, 'cosign.key'), pub: join(d, 'cosign.pub') };
};
let a;
let b;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'uv-signing-key-'));
  a = pair('a', PASSWORD);
  b = pair('b', PASSWORD);
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('[LR5] the right password and the matching public key pass', () => {
  assert.equal(signingKeyProblem({ key: a.key, pub: a.pub, password: PASSWORD }), null);
});

test('[LR5] a wrong password is refused, naming the key and never the password', () => {
  const p = signingKeyProblem({ key: a.key, pub: a.pub, password: 'not-the-password' });
  assert.match(p, /could not be opened with that password/);
  assert.doesNotMatch(p, /not-the-password|throwaway-test-password/);
});

test('[LR5] a key that is not the committed public key\'s is refused', () => {
  assert.match(signingKeyProblem({ key: a.key, pub: b.pub, password: PASSWORD }), /is not the key .* names/);
});

test('[LR5] PEM comparison ignores line endings and wrapping only', () => {
  const pem = '-----BEGIN PUBLIC KEY-----\nAAAA\nBBBB\n-----END PUBLIC KEY-----\n';
  assert.equal(pemBody(pem.replace(/\n/g, '\r\n')), pemBody(pem));
  assert.notEqual(pemBody(pem.replace('BBBB', 'BBBC')), pemBody(pem));
});
