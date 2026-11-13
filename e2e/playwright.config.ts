import { defineConfig } from '@playwright/test';
import type { IntegrationFixtures } from './integration/lib/integrationFixture';

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import variants from './integration/variants.json';
const INTEGRATION_APPS = readdirSync(join(__dirname, 'integration/apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const INTEGRATION_MODES = ['dev', 'packaged'] as const;

export type IntegrationApp = (typeof INTEGRATION_APPS)[number];
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];
export type IntegrationVariant = null | 'plugin-copy' | 'bundled';

export default defineConfig<IntegrationFixtures>({
  timeout: 60000, // Integration scenarios include app startup and event propagation.
  workers: 1, // Serial execution
  retries: process.env.CI ? 2 : 0,
  maxFailures: process.platform === 'win32' ? 3 : 0,
  reporter: [
    ...(process.env.CI ? [['html'] as const] : []),
    ['list'],
    ...(process.platform === 'win32' ? [['./lib/windowsFailureReporter.ts'] as const] : []),
  ],
  use: {
    trace: process.platform === 'win32' ? 'retain-on-failure' : 'on-first-retry',
  },
  projects: [
    {
      name: 'e2e',
      timeout: 30000,
      testDir: './scenarios',
      testMatch: '**/*.scenario.ts',
    },
    ...INTEGRATION_APPS.flatMap((app) =>
      variants.flatMap(({ name }) =>
        INTEGRATION_MODES.map((mode) => ({
          name: `${app}${name === 'default' ? '' : `-${name}`}-${mode}`,
          testDir: './integration/scenarios',
          testMatch: '**/*.scenario.ts',
          use: { app, mode, variant: name === 'default' ? null : (name as IntegrationVariant) },
        }))
      )
    ),
  ],
});
