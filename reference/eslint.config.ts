// Flat config for the Bottega monorepo. Lints TypeScript across src, server,
// shared, scripts, and root configs. Uses the typescript-eslint
// `recommendedTypeChecked` preset; type-aware rules run via the
// `projectService` against the repo-root tsconfig.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Skip generated artifacts and vendored bits.
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'public/**',
      '**/*.min.js',
    ],
  },

  // Base JS recommended (applies to .js and .ts).
  js.configs.recommended,

  // typescript-eslint base + type-checked recommendations for TS files.
  ...tseslint.configs.recommendedTypeChecked,

  // Type-aware parser settings for every TS file in the tsconfig include.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  // Disable type-aware rules on plain JS (none today, but keep the escape hatch).
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  // React Hooks rules for the frontend.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Ban React.FC / React.FunctionComponent. typescript-eslint parses
      // qualified type references as TSTypeReference > TSQualifiedName
      // (left/right), not MemberExpression (object/property).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSTypeReference[typeName.left.name="React"][typeName.right.name="FC"]',
          message: 'Do not use React.FC. Declare props as a function-type parameter instead: function Foo({ a, b }: FooProps) {}',
        },
        {
          selector: 'TSTypeReference[typeName.left.name="React"][typeName.right.name="FunctionComponent"]',
          message: 'Do not use React.FunctionComponent. Declare props as a function-type parameter instead.',
        },
      ],
    },
  },

  // Browser globals for the frontend; node globals for backend & scripts.
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ['server/**/*.ts', 'scripts/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Tests run under Vitest with `globals: true`.
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      'src/test-setup.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        vi: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      // Tests intentionally fire-and-forget Promises and use `as never` casts.
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // Architecture-v2 boundary (docs/epics/architecture-v2.md): the task domain
  // is complete and epic-agnostic; the epic domain is a layer on top that
  // acts through the task facade; the conversation runtime imports neither
  // domain. CI-enforced so the rules outlive the document.
  // ---------------------------------------------------------------------------

  // Rule 1 — nothing outside the epic layer imports it. Allowed importers:
  // the epic zone itself, its two REST adapters (routes/epics.ts, and
  // routes/webhooks.ts for the inbound GitHub half — a comment on the epic's
  // final pull request starts its delivery agent), its WS channel adapter
  // (websocket/dispatch.ts), the boot entrypoint (index.ts wires initEpics),
  // the v0 data-conversion migration, and tests.
  {
    files: ['server/**/*.ts'],
    ignores: [
      'server/services/epics/**',
      'server/routes/epics.ts',
      'server/routes/webhooks.ts',
      'server/websocket/dispatch.ts',
      'server/index.ts',
      'server/database/epics.ts',
      'server/database/epicConversion.ts',
      '**/*.test.ts',
      'server/test/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/services/epics/**', '**/epics/orchestrator/**'],
              message:
                'The epic layer may only be imported by server/services/epics/**, its REST/WS adapters and the boot entrypoint (architecture-v2 rule 1).',
            },
            {
              group: ['**/database/epics', '**/database/epics.js'],
              message:
                'Only the epic layer may read the epic tables (architecture-v2 rule 1).',
            },
          ],
        },
      ],
    },
  },

  // Rule 2 — the epic layer acts on tasks only through the task facade
  // (server/services/tasks/index.ts) and the task domain's own service files
  // it re-exports. Direct table access and task-internal modules are out.
  {
    files: ['server/services/epics/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/database/tasks', '**/database/tasks.js'],
              message:
                'The epic layer may not read the task tables — go through the task facade (services/tasks/index.ts).',
            },
            {
              // `tasks/events` is deliberately NOT here: the event stream is
              // the task domain's published contract (rule 3), exactly what
              // the epic layer subscribes to.
              group: [
                '**/taskService', '**/taskService.js',
                '**/tasks/baseBranch', '**/tasks/baseBranch.js',
                '**/tasks/adapter', '**/tasks/adapter.js',
                '**/tasks/worktreeSetup', '**/tasks/worktreeSetup.js',
                '**/agentRunner', '**/agentRunner.js',
              ],
              message:
                'Task-internal module — import the task facade (services/tasks/index.ts) instead (architecture-v2 rule 2).',
            },
          ],
        },
      ],
    },
  },

  // Rule 3 — the conversation runtime imports neither domain; ownership
  // questions go through the owner-adapter registry.
  {
    files: ['server/services/conversation/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/services/epics/**', '**/epics/orchestrator/**',
                '**/database/epics', '**/database/epics.js',
                '**/database/tasks', '**/database/tasks.js',
                '**/tasks/index', '**/tasks/index.js',
                '**/tasks/baseBranch', '**/tasks/baseBranch.js',
                '**/tasks/events', '**/tasks/events.js',
                '**/tasks/adapter', '**/tasks/adapter.js',
                '**/tasks/worktreeSetup', '**/tasks/worktreeSetup.js',
                '**/taskService', '**/taskService.js',
              ],
              message:
                'The conversation runtime imports neither domain — dispatch through the owner-adapter registry (architecture-v2 rule 3).',
            },
          ],
        },
      ],
    },
  },

  // Repo-root config files (vite, vitest, tailwind, eslint itself) run under
  // Node.
  {
    files: ['*.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Repo-wide overrides.
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'preserve-caught-error': 'error',
      'no-useless-catch': 'error',
      'no-control-regex': 'error',
      'no-case-declarations': 'error',
      'require-yield': 'error',

      // The `no-unsafe-*` family flags every operation on a value typed
      // `any` (or returning `any`). The SDK / ws / JSON.parse boundaries
      // produce hundreds of these; surfacing as warnings keeps them visible
      // for opportunistic cleanup without blocking CI. The zod boundary
      // layer (commit 5) is the long-term cure.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // `require-await` flags async functions with no await — sometimes
      // intentional (returning a Promise to satisfy an interface). Warn.
      '@typescript-eslint/require-await': 'warn',

      // Same idea: a redundant type constituent is style, not a bug.
      '@typescript-eslint/no-redundant-type-constituents': 'warn',

      // `restrict-template-expressions` is noisy on console.error / log.
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // `unbound-method` flags passing `obj.method` as a callback; in this
      // codebase that's an intentional pattern for SDK callbacks.
      '@typescript-eslint/unbound-method': 'warn',

      // The void-return form of `no-misused-promises` flags every
      // `onClick={async () => ...}` in React. Skip it; keep the form that
      // catches `if (someAsync())` and similar real bugs.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
    },
  },

  // Test fixtures sometimes spell `project_id: 1, …, project_id: 1` as a typo
  // — harmless at runtime (last write wins). Surface as warnings for clean-up.
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-dupe-keys': 'warn',
    },
  },
);
