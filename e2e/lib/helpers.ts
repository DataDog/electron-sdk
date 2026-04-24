import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Intake } from './intake';
import { MainPage } from './mainPage';
import type { InitConfiguration } from '@datadog/electron-sdk';

// Get electron executable path from the app's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../app/node_modules/electron')) as string;

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
  mainPage: MainPage;
  intake: Intake;
  rumBrowserSdk: Record<string, unknown> | null;
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

  electronApp: async ({ intake, rumBrowserSdk }, use) => {
    const userDataDir = await createUserDataDir();
    const electronApp = await launchApp(intake, userDataDir, rumBrowserSdk);
    await use(electronApp);
    await electronApp.close();
    await cleanupUserDataDir(userDataDir);
  },

  window: [
    async ({ electronApp }, use) => {
      const { window } = await waitForWindowLoaded(electronApp);
      await use(window);
    },
    { auto: true },
  ],

  mainPage: async ({ window }, use) => {
    await use(new MainPage(window));
  },

  rumBrowserSdk: [null, { option: true }],
});

async function launchApp(
  intake: Intake,
  userDataDir: string,
  rumBrowserSdk: Record<string, unknown> | null = null
): Promise<ElectronApplication> {
  const env: Record<string, string> = {
    ...process.env,
  } as Record<string, string>;

  const electronSdkConfig: InitConfiguration = {
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
  env.DD_ELECTRON_SDK_CONFIG = JSON.stringify(electronSdkConfig);

  if (rumBrowserSdk !== null) {
    env.DD_RUM_BROWSER_SDK = JSON.stringify({
      applicationId: 'blank',
      clientToken: 'blank',
      site: 'datadoghq.com',
      service: 'e2e-main-window',
      sessionSampleRate: 100,
      trackUserInteractions: true,
      ...rumBrowserSdk,
    });
  }

  return electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '../app/dist/main.js'), `--user-data-dir=${userDataDir}`],
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
  intake: Intake,
  userDataDir: string
): Promise<{ electronApp: ElectronApplication; window: Page; mainPage: MainPage }> {
  const electronApp = await launchApp(intake, userDataDir);
  const { window } = await waitForWindowLoaded(electronApp);
  return { electronApp, window, mainPage: new MainPage(window) };
}

export async function createUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'electron-sdk-e2e-'));
}

export async function cleanupUserDataDir(userDataDir: string): Promise<void> {
  await rm(userDataDir, { recursive: true, force: true });
}

export { expect } from '@playwright/test';
