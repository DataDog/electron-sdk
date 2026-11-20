import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'bazel.scenario.ts',
  timeout: 60_000,
  workers: 1,
  projects: ['default-copy', 'plugin-copy'].map((workflow) => ({ name: `bazel-${workflow}`, metadata: { workflow } })),
});
