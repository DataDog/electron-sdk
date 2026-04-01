import { defineConfig } from '@playwright/test';
import type { IntegrationFixtures } from './integration/lib/integrationFixture';

const INTEGRATION_APPS = ['forge-webpack', 'forge-vite', 'electron-vite', 'electron-builder-vite'] as const;
const INTEGRATION_MODES = ['dev', 'packaged'] as const;

export type IntegrationApp = (typeof INTEGRATION_APPS)[number];
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export default defineConfig<IntegrationFixtures>({
  timeout: 30000,
  workers: 1, // Serial execution
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'e2e',
      testDir: './scenarios',
      testMatch: '**/*.scenario.ts',
    },
    ...INTEGRATION_APPS.flatMap((app) =>
      INTEGRATION_MODES.map((mode) => ({
        name: `${app}-${mode}`,
        testDir: './integration/scenarios',
        testMatch: '**/*.scenario.ts',
        use: { app, mode },
      }))
    ),
  ],
});
