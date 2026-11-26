import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint configuration for the backend packages (server, scheduler, worker, engine, SDK,
 * protocol, shared, database, examples). The Next.js dashboard has its own config in
 * apps/dashboard/eslint.config.mjs.
 *
 * Note: `consistent-type-imports` is intentionally not enabled. NestJS dependency
 * injection reads constructor parameter types from decorator metadata, which needs
 * value imports.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'apps/dashboard/**', 'apps/dashboard-lite/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': ['error', { allow: ['warn', 'error', 'info', 'debug'] }],
    },
  },
);
