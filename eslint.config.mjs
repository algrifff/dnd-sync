// Flat ESLint config. Kept intentionally minimal — we lean on TypeScript
// for correctness and Prettier for formatting. Rules are added only when
// they catch real bugs.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/main.js',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      // Self-hosted authed app with content-hashed user uploads — next/image
      // brings no payoff and costs runtime (sharp) + config surface.
      '@next/next/no-img-element': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Deliberately plain CommonJS — see the file header. It's the
    // Railway-shell fallback for apply-bundle.ts and must keep running
    // under plain `node` with no TS/path-alias resolution, so it can't
    // switch to ESM imports. Scope the Node globals + require() carve-out
    // to just this script rather than loosening the rule project-wide.
    files: ['scripts/main-notes-import/*.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
