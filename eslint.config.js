import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/cdk.out/**',
      '**/node_modules/**',
      'design/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.kat/**',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['web/*.config.ts', 'web/delivery.ts'],
          defaultProject: 'web/tsconfig.node.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['error', { allow: ['error', 'warn'] }],
      // JSX handlers like onClick={() => setOpen(true)} are idiomatic.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/test/**', '**/scripts/**', '**/bin/**', '**/e2e/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Vitest asymmetric matchers (expect.any, expect.stringContaining, ...) are typed `any`.
    files: ['**/test/**'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
