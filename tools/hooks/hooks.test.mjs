// Spec 0024 H1–H2: the hooks' own logic (node --test tools/hooks/hooks.test.mjs). The hooks themselves are proved on a
// fresh clone (the spec's implementation notes, GC8).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TYPES } from '../../commitlint.config.mjs';
import { ASSETS, assetFor, VERSION, verified } from './gitleaks.mjs';
import { skipReason } from './install.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = fileURLToPath(new URL('../../node_modules/@commitlint/cli/cli.js', import.meta.url));
/** commitlint's verdict on one message, as the commit-msg hook gives it. */
const lint = (message) => spawnSync(process.execPath, [CLI], { cwd: ROOT, input: message, encoding: 'utf8' }).status;

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

describe('[H2] the commit message (G10, as the PR title)', () => {
  it("uses G10's types", () => {
    assert.deepEqual(TYPES, ['feat', 'fix', 'docs', 'test', 'build', 'ci', 'chore', 'refactor', 'perf']);
  });
  it('accepts type(scope): description, a breaking-change mark, a long header and a body', () => {
    assert.equal(lint('feat(results): amendments carry their reason\n'), 0);
    assert.equal(lint('fix(api-client)!: the token moves to a cookie\n'), 0);
    assert.equal(lint(`docs(stack): ${'a long subject, '.repeat(10).trimEnd()}\n\n${'a body line longer than a hundred characters, '.repeat(3)}\n`), 0);
  });
  it('refuses no type, an unknown type, no scope, an uppercase scope, and no description', () => {
    for (const m of ['update stuff', 'wip(results): halfway', 'feat: no scope', 'feat(Results): upper', 'feat(results):'])
      assert.notEqual(lint(`${m}\n`), 0, m);
  });
});
