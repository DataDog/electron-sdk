import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.scenario.ts',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
