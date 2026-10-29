// Shared ESLint flat config for the whole workspace — docs/17-coding-standards.md §1, §8.
// Each package runs `eslint .`; ESLint resolves this file by walking up from the linted files.
import js from '@eslint/js';
import storybook from 'eslint-plugin-storybook';
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
      // Spec 0026 SB7: Storybook's static build, a CI check only.
      '**/storybook-static/**',
      // Spec 0024 G8: deliberately bad inputs for the security gates' proofs, never shipped or run.
      'tools/security/fixtures/**',
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
          // 24 since spec 0016 added the capture gate and its suite (18 files today); raise it deliberately, not by habit.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 24,
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

  // Operator CLIs (apps/*/src/cli), and the migrate job's entrypoint (spec 0019 D3): stdout is their interface.
  // They print names, counts and versions only.
  {
    files: ['apps/*/src/cli/**/*.ts', 'apps/migrate/src/main.ts'],
    rules: { 'no-console': 'off' },
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
  // Browser code: the web app and the UI kit (spec 0005), with its stories and their proof (spec 0026).
  {
    files: ['apps/web/src/**', 'packages/ui/src/**', 'packages/ui/.storybook*/**', 'packages/ui/proof/**'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Spec 0011 OA8: the web app calls the API only through the generated client. The two transports
  // (lib/server-api.ts forwards the user's request; packages/api-client wraps fetch) and the one request
  // that goes to storage, not the API (lib/storage-upload.ts), are the named exceptions.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    ignores: [...TEST_FILES, 'apps/web/src/lib/server-api.ts', 'apps/web/src/lib/storage-upload.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Call the API through the generated client (lib/client-api, lib/server-api; spec 0011).' },
        { name: 'XMLHttpRequest', message: 'Only lib/storage-upload.ts talks to storage directly (spec 0011).' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          // A hand-written API path. Allowed: the typed client's own path argument, and type positions.
          selector:
            ":matches(Literal[value=/^.api.v1./], TemplateElement[value.raw=/^.api.v1./]):not(TSLiteralType > Literal):not(CallExpression[callee.property.name=/^(GET|POST|PUT|DELETE)$/] > Literal.arguments)",
          message: 'API paths are typed: use client.GET/POST/PUT/DELETE (or contentUrl) from the generated client (spec 0011).',
        },
        {
          selector: "MemberExpression[property.name='fetch'][object.name=/^(window|globalThis|self)$/]",
          message: 'Call the API through the generated client (spec 0011).',
        },
      ],
    },
  },

  // Spec 0026 SB8: Storybook's recommended rules for stories and its config.
  ...storybook.configs['flat/recommended'],
);
