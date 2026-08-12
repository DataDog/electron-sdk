import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../node_modules/electron')) as string;

// Separate fixture from helpers.ts: no fake intake, no DD_SDK_PROXY — events go to real staging.
const test = base.extend<{ electronApp: ElectronApplication; window: Page }>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const extraArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : [];
    const app = await electron.launch({
      executablePath: electronPath,
      args: [join(__dirname, '../dist/main.js'), ...extraArgs],
      env: {
        ...process.env,
        DD_TEST_MODE: '1',
        // No DD_SDK_PROXY — events reach real staging
      },
    });
    app.process().stdout?.on('data', (data: Buffer) => process.stdout.write(data));
    app.process().stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    await use(app);
    await app.close();
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('load');
    await use(window);
  },
});

async function flushTransport(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { electronAPI: { flushTransport: () => Promise<void> } }).electronAPI.flushTransport()
  );
}

test('generate execution_context events and send to staging', async ({ electronApp, window }) => {
  // Open secondary window and capture its page handle
  const secondaryWindowPromise = electronApp.waitForEvent('window');
  await window.click('#open-secondary-window');
  const secondaryPage = await secondaryWindowPromise;
  await secondaryPage.waitForLoadState('load');

  // Trigger an error from the secondary renderer
  await secondaryPage.click('#error-btn');

  // Let the renderer process live for a couple seconds
  await secondaryPage.waitForTimeout(2_000);

  // Close secondary window (no close button in main UI — close via main process)
  await electronApp.evaluate(({ BrowserWindow }) => {
    const secondary = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('secondary'));
    secondary?.close();
  });

  // Let the end execution_context event emit and flush everything to staging
  await window.waitForTimeout(500);
  await flushTransport(window);
});
