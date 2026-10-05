// Shared ESLint flat config for the whole workspace — docs/17-coding-standards.md §1, §8.
// Each package runs `eslint .`; ESLint resolves this file by walking up from the linted files.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TEST_FILES = ['**/*.spec.ts', '**/test/**', '**/testing/**', '**/e2e/**'];
const TOOLING_FILES = ['**/scripts/**', '**/*.config.ts', 'tools/**'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          // Files outside a package's tsconfig `include` (tooling, db scripts/tests) get a default project.
          allowDefaultProject: [
            '*/*/*.config.ts',
            'packages/db/scripts/*.ts',
            'packages/db/test/*.ts',
            'packages/crypto/scripts/*.ts',
          ],
          defaultProject: 'tsconfig.base.json',
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // NestJS modules are decorated, intentionally empty classes.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // `.catch((err) => logger.error(...))` is idiomatic; braces would add noise, not safety.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Numbers in log/error messages are fine; everything else must be stringified on purpose.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Banned in production code (docs/17 §8). Tests, scripts and tooling are exempt.
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: [...TEST_FILES, ...TOOLING_FILES],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use node:crypto (randomBytes / randomUUID).',
        },
        { property: '$queryRawUnsafe', message: 'Use $queryRaw with a tagged template.' },
        { property: '$executeRawUnsafe', message: 'Use $executeRaw with a tagged template.' },
      ],
    },
  },

  // Tests: fixtures are known to exist and HTTP response bodies are untyped (`any`), so
  // asserting presence and reading body fields is the point of the test, not a hazard.
  {
    files: TEST_FILES,
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Plain JS (tooling) has no types to check.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Browser code: the web app and the UI kit (spec 0005).
  {
    files: ['apps/web/src/**', 'packages/ui/src/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
