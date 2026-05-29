import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { Intake } from '../../e2e/lib/intake';

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
        DD_SDK_PROXY: `http://localhost:${intake.getPort()}`,
        // Required when electron-sdk/node_modules/dd-trace is a portal symlink (local dev).
        NODE_OPTIONS: '--preserve-symlinks',
      } as Record<string, string>,
    });

    // Capture main process stdout/stderr for debugging
    app.process().stdout?.on('data', (data: Buffer) => console.log('[main]', data.toString().trim()));
    app.process().stderr?.on('data', (data: Buffer) => console.error('[main:err]', data.toString().trim()));

    await use(app);
    await app.close();
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    window.on('console', (msg) => console.log('[renderer]', msg.text()));
    await window.waitForLoadState('load');
    await window.waitForTimeout(500);
    await use(window);
  },
});

export async function flushTransport(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { electronAPI: { flushTransport: () => Promise<void> } }).electronAPI.flushTransport()
  );
}

export { expect } from '@playwright/test';
