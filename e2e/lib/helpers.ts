import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { Intake } from './intake';
import { AppPage } from './appPage';
import type { InitConfiguration } from '@datadog/electron-sdk';

// Get electron executable path from the app's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../app/node_modules/electron')) as string;

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
  app: AppPage;
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
    const electronApp = await launchApp(intake);
    await use(electronApp);
    await electronApp.close();
  },

  window: [
    async ({ electronApp }, use) => {
      const { window } = await waitForWindowLoaded(electronApp);
      await use(window);
    },
    { auto: true },
  ],

  app: async ({ window }, use) => {
    await use(new AppPage(window));
  },
});

async function launchApp(intake: Intake): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...process.env,
  } as Record<string, string>;

  const config: InitConfiguration = {
    site: 'datadoghq.com',
    proxy: `http://localhost:${intake.getPort()}/api/v2/rum`,
    clientToken: 'test-client-token',
    service: 'e2e-test-app',
    applicationId: 'e2e-test-app-id',
    env: 'test',
    version: '1.0.0',
    telemetrySampleRate: 100,
    defaultPrivacyLevel: 'mask',
    allowedWebViewHosts: [],
  };
  env.DD_SDK_CONFIG = JSON.stringify(config);

  return electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '../app/dist/main.js')],
    env,
  });
}

async function waitForWindowLoaded(electronApp: ElectronApplication): Promise<{ window: Page }> {
  const window = await electronApp.firstWindow();
  window.on('console', (msg) => console.log('Browser console:', msg.text()));
  await window.waitForLoadState('load');
  await window.waitForTimeout(500);
  return { window };
}

export async function launchAppManually(
  intake: Intake
): Promise<{ electronApp: ElectronApplication; window: Page; app: AppPage }> {
  const electronApp = await launchApp(intake);
  const { window } = await waitForWindowLoaded(electronApp);
  return { electronApp, window, app: new AppPage(window) };
}

export { expect } from '@playwright/test';
