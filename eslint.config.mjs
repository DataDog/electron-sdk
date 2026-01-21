import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', '*.js', '*.cjs', '*.mjs', '**/*.d.ts', 'e2e/**/*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['playground/src/**/*.ts'],
    ignores: ['playground/src/renderer.ts'],
    languageOptions: {
      parserOptions: {
        project: './playground/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['playground/src/renderer.ts'],
    languageOptions: {
      parserOptions: {
        project: './playground/tsconfig.renderer.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['e2e/scenarios/**/*.ts', 'e2e/lib/**/*.ts', 'e2e/playwright.config.ts'],
    languageOptions: {
      parserOptions: {
        project: './e2e/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['e2e/app/src/**/*.ts'],
    ignores: ['e2e/app/src/renderer.ts'],
    languageOptions: {
      parserOptions: {
        project: './e2e/app/tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['e2e/app/src/renderer.ts'],
    languageOptions: {
      parserOptions: {
        project: './e2e/app/tsconfig.renderer.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier
);
