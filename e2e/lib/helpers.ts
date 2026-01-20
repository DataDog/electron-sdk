import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'path';

// Get electron executable path from the app's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../app/node_modules/electron')) as string;

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
}

/**
 * Custom Playwright test with Electron app fixtures.
 * Automatically launches the app before each test and closes it after.
 */
export const test = base.extend<TestFixtures>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    // Setup: Launch Electron app
    const electronApp = await electron.launch({
      executablePath: electronPath,
      args: [join(__dirname, '../app/dist/main.js')],
    });

    // Provide the app to the test
    await use(electronApp);

    // Teardown: Close the app
    await electronApp.close();
  },

  window: async ({ electronApp }, use) => {
    // Setup: Get the first window and configure it
    const window = await electronApp.firstWindow();

    // Log console messages for debugging
    window.on('console', (msg) => console.log('Browser console:', msg.text()));

    // Wait for window to be fully loaded including scripts
    await window.waitForLoadState('load');

    // Wait a bit for renderer script to execute
    await window.waitForTimeout(500);

    // Provide the window to the test
    await use(window);

    // Teardown: automatic when electronApp closes
  },
});

export { expect } from '@playwright/test';
