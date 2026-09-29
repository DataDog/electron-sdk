import { defineConfig } from '@playwright/test';
import type { IntegrationFixtures } from './integration/lib/integrationFixture';

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCompatibilityRun } from './lib/compatibility';
const INTEGRATION_APPS = readdirSync(join(__dirname, 'integration/apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const INTEGRATION_MODES = ['dev', 'packaged'] as const;

export type IntegrationApp = (typeof INTEGRATION_APPS)[number];
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];
export type IntegrationVariant = null | 'packager-copy';

export default defineConfig<IntegrationFixtures>({
  timeout: 60000, // Integration scenarios include app startup and event propagation.
  workers: 1, // Serial execution
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html'], ['list']] : 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'e2e',
      timeout: 30000,
      testDir: './scenarios',
      testMatch: '**/*.scenario.ts',
    },
    ...INTEGRATION_APPS.flatMap((app) =>
      INTEGRATION_MODES.map((mode) => ({
        name: `${app}-${mode}`,
        testDir: './integration/scenarios',
        testMatch: '**/*.scenario.ts',
        use: { app, mode, variant: null },
      }))
    ),
    ...(getCompatibilityRun() ? INTEGRATION_APPS : ['electron-builder-vite']).map((app) => ({
      name: `${app}-packager-copy-packaged`,
      testDir: './integration/scenarios',
      testMatch: '**/*.scenario.ts',
      use: { app, mode: 'packaged' as const, variant: 'packager-copy' as const },
    })),
  ],
});
