// Spec 0024 G10: a squash merge makes the PR's title the commit on main, so the title is checked as a Conventional
// Commit: `type(scope): description`, with a known type and a lowercase scope.
//   PR_TITLE='…' node tools/security/pr-title.mjs
// The title comes in through the environment, never interpolated into a shell command.
import { pathToFileURL } from 'node:url';

export const TYPES = ['feat', 'fix', 'docs', 'test', 'build', 'ci', 'chore', 'refactor', 'perf'];
const TITLE = new RegExp(`^(${TYPES.join('|')})\\(([a-z0-9][a-z0-9-]*)\\)(!)?: (\\S.*)$`);

/** Why the title isn't a Conventional Commit, or null. */
export function titleProblem(title) {
  const t = String(title ?? '');
  if (!t.trim()) return 'the title is empty';
  if (TITLE.test(t)) return null;
  const type = /^([a-z]+)[(:!]/.exec(t)?.[1];
  if (!type) return 'it does not start with a type: `type(scope): description`';
  if (!TYPES.includes(type)) return `"${type}" is not a type (${TYPES.join(', ')})`;
  if (!/^[a-z]+\(/.test(t)) return 'the scope is missing: `type(scope): description`, the scope being the module';
  if (!/^[a-z]+\([a-z0-9][a-z0-9-]*\)/.test(t)) return 'the scope must be lowercase letters, digits and hyphens';
  return 'after the scope comes `: ` and a description';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const title = process.env.PR_TITLE ?? '';
  const p = titleProblem(title);
  if (p) {
    console.error(`The PR title is not a Conventional Commit (spec 0024 G10): ${p}. It becomes the commit on main.`);
    process.exit(1);
  }
  console.log('The PR title is a Conventional Commit (spec 0024 G10).');
}
