import { createRequire } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';
import unicorn from 'eslint-plugin-unicorn';

const require = createRequire(import.meta.url);
const forceBarrelImports = require('eslint-plugin-force-barrel-imports');

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '*.mjs',
      'rum-events-format/**',
      '**/rumEvent.types.ts',
      '**/telemetryEvent.types.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      unicorn,
      'force-barrel-imports': forceBarrelImports,
    },
    settings: {
      'import/resolver': {
        typescript: true,
        node: true,
      },
    },
    rules: {
      'unicorn/prefer-node-protocol': 'error',
      'force-barrel-imports/force-barrel-imports': 'error',
    },
  },
  // Release some rules outside of source code
  {
    files: ['e2e/**/*.ts', 'playground/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'force-barrel-imports/force-barrel-imports': 'off',
    },
  },
  prettier
);
