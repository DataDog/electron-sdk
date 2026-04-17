import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { Intake } from '../../e2e/lib/intake';

// Get electron executable path from the playground's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../node_modules/electron')) as string;

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
  intake: Intake;
}

/**
 * Custom Playwright test with playground app fixtures.
 * Launches the playground app pointed at a mock intake server.
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
    const electronApp = await electron.launch({
      executablePath: electronPath,
      args: [join(__dirname, '../dist/main.js')],
      env: {
        ...process.env,
        DD_TEST_MODE: '1',
        // Override SDK config to point at mock intake
        DD_SDK_PROXY: `http://localhost:${intake.getPort()}/api/v2/rum`,
      } as Record<string, string>,
    });
    await use(electronApp);
    await electronApp.close();
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    window.on('console', (msg) => console.log('Playground console:', msg.text()));
    await window.waitForLoadState('load');
    await window.waitForTimeout(500);
    await use(window);
  },
});

export { expect } from '@playwright/test';

/** Flush SDK transport so buffered events reach the mock intake. */
export async function flushTransport(window: Page): Promise<void> {
  await window.evaluate(() =>
    (window as unknown as { electronAPI: { flushTransport(): Promise<void> } }).electronAPI.flushTransport()
  );
}
