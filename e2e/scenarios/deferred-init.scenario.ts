import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { InitConfiguration } from '@datadog/electron-sdk';
import { Intake } from '../lib/intake';
import { MainPage } from '../lib/mainPage';
import { createUserDataDir, cleanupUserDataDir, launchDeferredInitApp } from '../lib/helpers';

const MARKER_HOST = 'deferred-init.example.com';
// A page loaded before init() must not be blocked: without the instrument-time responder the preload's
// synchronous config request blocks (~30s), so this bounded wait fails the test.
const PRE_INIT_LOAD_TIMEOUT = 10_000;

async function readAllowedHosts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as { DatadogEventBridge: { getAllowedWebViewHosts(): string } })
      .DatadogEventBridge;
    return JSON.parse(bridge.getAllowedWebViewHosts()) as string[];
  });
}

async function readPrivacyLevel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as { DatadogEventBridge: { getPrivacyLevel(): string } }).DatadogEventBridge;
    return bridge.getPrivacyLevel();
  });
}

// Runs init() in the main process via the deferred-init test hook (no renderer needed).
async function runInit(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(async () => {
    await (globalThis as unknown as { __ddE2E: { init: () => Promise<void> } }).__ddE2E.init();
  });
}

// Opens the app window via the deferred-init test hook and waits for it to finish loading.
async function openWindow(electronApp: ElectronApplication, timeout?: number): Promise<Page> {
  const [window] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(() => {
      (globalThis as unknown as { __ddE2E: { openWindow: () => void } }).__ddE2E.openWindow();
    }),
  ]);
  await window.waitForLoadState('load', timeout === undefined ? undefined : { timeout });
  return window;
}

test.describe('deferred init', () => {
  let intake: Intake;
  let userDataDir: string;
  let electronApp: ElectronApplication;

  test.beforeEach(async () => {
    intake = new Intake();
    await intake.start();
    userDataDir = await createUserDataDir();
  });

  test.afterEach(async () => {
    await electronApp.close();
    await cleanupUserDataDir(userDataDir);
    await intake.stop();
  });

  async function launch(sdkConfigOverrides?: Partial<InitConfiguration>): Promise<void> {
    electronApp = await launchDeferredInitApp(intake, userDataDir, sdkConfigOverrides);
  }

  test('page loaded before init is not blocked and stays on the bridge', async () => {
    await launch();
    const window = await openWindow(electronApp, PRE_INIT_LOAD_TIMEOUT);
    expect(await readAllowedHosts(window)).toEqual(['*', '']);
  });

  test('page loaded after init reads the configured value', async () => {
    await launch();
    await runInit(electronApp);
    const window = await openWindow(electronApp);
    expect(await readAllowedHosts(window)).toContain(MARKER_HOST);
    expect(await readPrivacyLevel(window)).toBe('allow');
  });

  test('page loaded before init sends nothing until it reloads', async () => {
    await launch({ allowedRendererHosts: ['*'] });
    const mainPage = new MainPage(await openWindow(electronApp));
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await runInit(electronApp);

    await bridgeWindow.generateError('before reload');
    await bridgeWindow.reload();
    await bridgeWindow.generateError('after reload');

    const errors = await mainPage.whileFlushing(() => intake.getSettledEventsByType('error'));
    expect(errors.map(({ body }) => body.error.message)).toEqual(['after reload']);
  });
});
