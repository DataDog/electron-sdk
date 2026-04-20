import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { Intake } from '../../e2e/lib/intake';
import type { RumErrorEvent } from '@datadog/electron-sdk';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../node_modules/electron')) as string;

const useProxy = !process.env.DD_DISABLE_PROXY;

const test = base.extend<{ intake: Intake | null }>({
  intake: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      if (useProxy) {
        const intake = new Intake();
        await intake.start();
        await use(intake);
        await intake.stop();
      } else {
        await use(null);
      }
    },
    { option: true },
  ],
});

async function launchPlayground(intake: Intake | null): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DD_TEST_MODE: '1',
  };

  if (useProxy && intake) {
    env.DD_SDK_PROXY = `http://localhost:${intake.getPort()}/api/v2/rum`;
  }

  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '../dist/main.js')],
    env,
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('load');
  return { electronApp, window };
}

async function flushTransport(page: Page): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  await page.evaluate(() => (window as any).electronAPI.flushTransport());
}

test('sends crash event after native crash', async ({ intake }) => {
  test.setTimeout(60_000);

  // Phase 1: Launch and crash
  const { electronApp: firstApp, window: firstWindow } = await launchPlayground(intake);
  await flushTransport(firstWindow);

  const appClosed = firstApp.waitForEvent('close');
  void firstWindow
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    .evaluate(() => (window as any).electronAPI.crash())
    .catch(() => {
      // app will crash, evaluate promise rejects
    });
  await appClosed;

  if (intake) {
    intake.clear();
  }

  // Phase 2: Relaunch — SDK init triggers crash dump collection
  const { electronApp: secondApp, window: secondWindow } = await launchPlayground(intake);

  try {
    await flushTransport(secondWindow);

    if (intake) {
      // Increased timeout to account for WASM crash dump processing
      const errorEvents = await intake.getEventsByType('error', 15_000);
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      const crashEvents = errorEvents.filter((e) => (e.body as RumErrorEvent).error.is_crash === true);
      expect(crashEvents).toHaveLength(1);

      const error = crashEvents[0].body as RumErrorEvent;
      expect(error.error.source).toBe('source');
      expect(error.error.handling).toBe('unhandled');
      expect(error.error.category).toBe('Exception');
      expect(error.error.stack).toBeTruthy();
      expect(error.error.threads).toBeDefined();
      expect(error.error.binary_images).toBeDefined();
    } else {
      // No proxy: wait for crash dump processing + network flush to staging
      await secondWindow.waitForTimeout(15_000);
      await flushTransport(secondWindow);
      await secondWindow.waitForTimeout(2_000);
    }
  } finally {
    await secondApp.close();
  }
});
