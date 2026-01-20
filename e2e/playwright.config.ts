import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './scenarios',
  testMatch: '**/*.scenario.ts',
  timeout: 30000,
  workers: 1, // Serial execution
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    trace: 'on-first-retry',
  },
});
