// Spec 0024 H1: `pnpm install`'s prepare step installs the git hooks (lefthook.yml), but only where they belong. It
// skips, saying why, in CI (which is the gate, and runs every check itself), outside a git checkout (the image builds,
// whose context excludes .git), and where lefthook isn't installed (a production install).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Why the hooks aren't installed here, or null to install them. */
export function skipReason({ env, inGitCheckout, hasLefthook }) {
  if (env.CI) return 'CI';
  if (!inGitCheckout) return 'not a git checkout';
  if (!hasLefthook) return 'lefthook is not installed';
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, encoding: 'utf8' });
  const lefthook = fileURLToPath(new URL('../../node_modules/lefthook/bin/index.js', import.meta.url));
  const reason = skipReason({ env: process.env, inGitCheckout: git.status === 0 && git.stdout.trim() === 'true', hasLefthook: existsSync(lefthook) });
  if (reason) {
    console.log(`git hooks: not installed (${reason}).`);
    process.exit(0);
  }
  const r = spawnSync(process.execPath, [lefthook, 'install'], { cwd: ROOT, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
