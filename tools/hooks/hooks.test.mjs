// Spec 0024 H1–H2: the hooks' own logic (node --test tools/hooks/hooks.test.mjs). The hooks themselves are proved on a
// fresh clone (the spec's implementation notes, GC8).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messageProblem } from './commit-msg.mjs';
import { ASSETS, assetFor, VERSION, verified } from './gitleaks.mjs';
import { skipReason } from './install.mjs';

describe('[H1] installing the hooks', () => {
  const here = { env: {}, inGitCheckout: true, hasLefthook: true };
  it('installs in a developer checkout', () => {
    assert.equal(skipReason(here), null);
  });
  it('skips in CI, outside a git checkout (the image builds), and without lefthook (a production install)', () => {
    assert.equal(skipReason({ ...here, env: { CI: 'true' } }), 'CI');
    assert.equal(skipReason({ ...here, inGitCheckout: false }), 'not a git checkout');
    assert.equal(skipReason({ ...here, hasLefthook: false }), 'lefthook is not installed');
  });
});

describe('[H2] the pinned gitleaks', () => {
  it("pins CI's version, and CI's linux_x64 checksum", () => {
    assert.equal(VERSION, '8.30.1');
    assert.equal(ASSETS['linux-x64'][1], '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb');
  });
  it('names each platform’s release asset, and refuses a platform with no pinned checksum', () => {
    assert.equal(assetFor('win32', 'x64').url, 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_windows_x64.zip');
    assert.match(assetFor('sunos', 'x64').problem, /no pinned gitleaks 8\.30\.1 for sunos-x64/);
  });
  it('accepts only the exact bytes', () => {
    const sha = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'; // SHA-256 of "hello world"
    assert.equal(verified(Buffer.from('hello world'), sha), true);
    assert.equal(verified(Buffer.from('hello world!'), sha), false);
  });
});

describe('[H2] the commit message, held to G10 by the PR-title check', () => {
  it('accepts type(scope): description with a body, and skips git comment lines', () => {
    assert.equal(messageProblem('feat(results): amendments carry their reason\n\nA body.\n'), null);
    assert.equal(messageProblem('# Please enter the commit message\nfix(api-client)!: the token moves to a cookie\n'), null);
  });
  it('refuses no type, an unknown type, no scope, an uppercase scope, and no description', () => {
    for (const m of ['update stuff', 'wip(results): halfway', 'feat: no scope', 'feat(Results): upper', 'feat(results):'])
      assert.ok(messageProblem(`${m}\n`), m);
  });
  it("leaves git's own messages: merges, reverts and fixups", () => {
    for (const m of ["Merge remote-tracking branch 'origin/main' into feat/x", "Merge branch 'main'", 'Revert "feat(x): y"', 'fixup! feat(x): y', 'squash! feat(x): y'])
      assert.equal(messageProblem(`${m}\n`), null, m);
  });
});
