import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify('test') },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'scripts/lib/*.ts'],
      exclude: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    },
  },
});
