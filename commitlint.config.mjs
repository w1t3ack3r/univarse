// Spec 0024 H2: the commit-msg hook holds each commit to the same rule CI holds the PR title to (G10):
// `type(scope): description`, with a known type and a lowercase scope. Conventional Commits' style rules beyond G10
// (header and body lengths, subject case) are off: G10 doesn't have them, and this repository's messages don't follow them.
export const TYPES = ['feat', 'fix', 'docs', 'test', 'build', 'ci', 'chore', 'refactor', 'perf'];

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', TYPES],
    'scope-empty': [2, 'never'],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-empty': [2, 'never'],
    'header-max-length': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'subject-case': [0],
  },
};
