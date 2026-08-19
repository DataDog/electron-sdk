import { defineConfig } from '@playwright/test';
import type { IntegrationFixtures } from './integration/lib/integrationFixture';
import compatibilityConfig from './compatibility/config.json';

interface IntegrationAppTemplate {
  id: string;
  kind: 'e2e' | 'integration';
  variants: {
    id: string;
    modes: string[];
  }[];
}

export type IntegrationApp = string;
export type IntegrationMode = 'dev' | 'packaged';
export type IntegrationVariant = string;

const integrationAppTemplates = (compatibilityConfig.appTemplates as IntegrationAppTemplate[]).filter(
  ({ kind }) => kind === 'integration'
);
const compatibilityRun = Boolean(process.env.DD_ELECTRON_COMPATIBILITY_ROOT);

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
    ...integrationAppTemplates.flatMap((app) =>
      app.variants
        .filter((variant) => compatibilityRun || variant.id === 'default')
        .flatMap((variant) =>
          variant.modes.map((mode) => {
            if (mode !== 'dev' && mode !== 'packaged') {
              throw new Error(`Unsupported integration mode "${mode}" in ${app.id}/${variant.id}.`);
            }
            const integrationMode: IntegrationMode = mode;
            return {
              name: `${app.id}-${variant.id === 'default' ? '' : `${variant.id}-`}${mode}`,
              testDir: './integration/scenarios',
              testMatch: '**/*.scenario.ts',
              use: {
                app: app.id,
                mode: integrationMode,
                variant: variant.id,
              },
            };
          })
        )
    ),
  ],
});
