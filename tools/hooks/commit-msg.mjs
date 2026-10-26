// Spec 0024 H2 (as amended 2026-10-26), the commit-msg hook: a commit's first line is held to G10, by the same code CI
// uses for the PR title (tools/security/pr-title.mjs), so the two can't drift. It takes about 0.2 s, where commitlint
// took 4 to 5 on the owner's machine.
//   node tools/hooks/commit-msg.mjs <message file>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { titleProblem } from '../security/pr-title.mjs';

/** Messages git writes itself, left as they are: a merge, a revert, and the fixups a rebase squashes away. */
const GIT_MADE = /^(Merge (branch|remote-tracking branch|pull request|commit) |Revert "|fixup! |squash! |amend! )/;

/** The message's first line, without git's comment lines; or why it can't be committed. */
export function messageProblem(text) {
  const header = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() && !l.startsWith('#'));
  if (header === undefined) return null; // an empty message: git itself aborts the commit
  if (GIT_MADE.test(header)) return null;
  return titleProblem(header);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node tools/hooks/commit-msg.mjs <message file>');
    process.exit(2);
  }
  const p = messageProblem(readFileSync(file, 'utf8'));
  if (p) {
    console.error(`The commit message is not a Conventional Commit (spec 0024 G10): ${p}.`);
    console.error('  Write it as `type(scope): description`, e.g. `fix(results): amendments keep their reason`.');
    process.exit(1);
  }
}
