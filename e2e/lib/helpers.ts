import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'path';
import { Intake } from './intake';
import type { InitConfiguration } from '@datadog/electron-sdk';

// Get electron executable path from the app's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../app/node_modules/electron')) as string;

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
  intake: Intake;
}

/**
 * Custom Playwright test with Electron app fixtures.
 * Automatically launches the app before each test and closes it after.
 */
export const test = base.extend<TestFixtures>({
  intake: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const intake = new Intake();
      await intake.start();
      await use(intake);
      await intake.stop();
    },
    { option: true },
  ],

  electronApp: async ({ intake }, use) => {
    const env: Record<string, string> = {
      ...process.env,
    } as Record<string, string>;

    const config: InitConfiguration = {
      proxy: `http://localhost:${intake.getPort()}/api/v2/rum`,
      clientToken: 'test-client-token',
      service: 'e2e-test-app',
      env: 'test',
      version: '1.0.0',
    };
    env.DD_SDK_CONFIG = JSON.stringify(config);

    const electronApp = await electron.launch({
      executablePath: electronPath,
      args: [join(__dirname, '../app/dist/main.js')],
      env,
    });

    await use(electronApp);
    await electronApp.close();
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    window.on('console', (msg) => console.log('Browser console:', msg.text()));
    await window.waitForLoadState('load');
    await window.waitForTimeout(500);
    await use(window);
  },
});

export { expect } from '@playwright/test';
