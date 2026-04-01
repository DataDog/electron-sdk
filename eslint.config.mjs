import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';
import unicorn from 'eslint-plugin-unicorn';
import noInternalModules from './eslint-local-rules/no-internal-modules.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '.claude/**',
      '**/*.mjs',
      'rum-events-format/**',
      '**/rumEvent.types.ts',
      '**/telemetryEvent.types.ts',
      'minidump-processor/**',
      // Integration apps are standalone projects with their own tsconfigs and toolchains.
      // They are not part of the root project service and are not linted here.
      'e2e/integration/apps/**',
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
      local: { rules: { 'no-internal-modules': noInternalModules } },
    },
    rules: {
      'unicorn/prefer-node-protocol': 'error',
      'local/no-internal-modules': 'error',
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
      'local/no-internal-modules': 'off',
    },
  },
  prettier
);
