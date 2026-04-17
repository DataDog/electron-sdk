import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { Intake } from '../../e2e/lib/intake';

// Get electron executable path from the playground's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../node_modules/electron')) as string;

export interface TestFixtures {
  intake: Intake;
  electronApp: ElectronApplication;
  window: Page;
}

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
    const app = await electron.launch({
      executablePath: electronPath,
      args: [join(__dirname, '../dist/main.js')],
      env: {
        ...process.env,
        DD_TEST_MODE: '1',
        DD_SDK_PROXY: `http://localhost:${intake.getPort()}/api/v2/rum`,
      } as Record<string, string>,
    });
    await use(app);
    await app.close();
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('load');
    await use(window);
  },
});

export async function flushTransport(page: Page): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  await page.evaluate(() => (window as any).electronAPI.flushTransport());
}

export { expect } from '@playwright/test';
