import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Intake } from './intake';
import { TestServer } from './testServer';
import { MainPage } from './mainPage';
import type { InitConfiguration } from '@datadog/electron-sdk';

// Get electron executable path from the app's node_modules
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require(join(__dirname, '../app/node_modules/electron')) as string;

// Variables forwarded to the Electron child process. Keep this list minimal:
// system essentials for the binary to launch, plus the few flags the test app
// and Playwright themselves read. Anything else is intentionally dropped to avoid
// leaking variables that change behavior (e.g. OTEL_TRACES_EXPORTER=otlp would
// make dd-trace switch off the experimental electron exporter the SDK relies on).
const HOST_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'DISPLAY',
  'XAUTHORITY',
  'CI',
  'PWDEBUG',
];

export interface TestFixtures {
  electronApp: ElectronApplication;
  window: Page;
  mainPage: MainPage;
  intake: Intake;
  testServer: TestServer;
  rumBrowserSdk: Record<string, unknown> | null;
  initialIntakeQuotaDecision: 'quota_ok' | 'quota_ko';
  sdkConfigOverrides: Partial<InitConfiguration> | null;
}

/**
 * Custom Playwright test with Electron app fixtures.
 * Automatically launches the app before each test and closes it after.
 */
export const test = base.extend<TestFixtures>({
  initialIntakeQuotaDecision: ['quota_ok', { option: true }],

  intake: [
    async ({ initialIntakeQuotaDecision }, use) => {
      const intake = new Intake();
      await intake.start();
      intake.setQuotaResponse(initialIntakeQuotaDecision);
      await use(intake);
      await intake.stop();
    },
    { option: true },
  ],

  testServer: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const testServer = new TestServer();
      await testServer.start();
      await use(testServer);
      await testServer.stop();
    },
    { option: true },
  ],

  electronApp: async ({ intake, rumBrowserSdk, sdkConfigOverrides }, use) => {
    const userDataDir = await createUserDataDir();
    const electronApp = await launchApp(intake, userDataDir, rumBrowserSdk, sdkConfigOverrides);
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

  sdkConfigOverrides: [null, { option: true }],
});

async function launchApp(
  intake: Intake,
  userDataDir: string,
  rumBrowserSdk: Record<string, unknown> | null = null,
  sdkConfigOverrides: Partial<InitConfiguration> | null = null,
  extraEnv: Record<string, string> = {}
): Promise<ElectronApplication> {
  const env: Record<string, string> = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  const electronSdkConfig: InitConfiguration = {
    site: 'datadoghq.com',
    proxy: `http://localhost:${intake.getPort()}`,
    clientToken: 'test-client-token',
    service: 'e2e-test-app',
    applicationId: 'e2e-test-app-id',
    env: 'test',
    version: '1.0.0',
    sessionSampleRate: 100,
    sessionReplaySampleRate: 100,
    profilingSampleRate: 100,
    telemetrySampleRate: 100,
    defaultPrivacyLevel: 'mask',
    allowedWebViewHosts: [],
    ...(sdkConfigOverrides ?? {}),
  };
  env.DD_ELECTRON_SDK_CONFIG = JSON.stringify(electronSdkConfig);

  if (rumBrowserSdk !== null) {
    env.DD_RUM_BROWSER_SDK = JSON.stringify({
      applicationId: 'blank',
      clientToken: 'blank',
      site: 'datadoghq.com',
      service: 'e2e-main-window',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 100,
      trackUserInteractions: true,
      ...rumBrowserSdk,
    });
  }

  Object.assign(env, extraEnv);

  return electron.launch({
    executablePath: electronPath,
    args: [join(__dirname, '../app/dist/main.js'), `--user-data-dir=${userDataDir}`],
    env,
  });
}

async function waitForWindowLoaded(electronApp: ElectronApplication): Promise<{ window: Page }> {
  const window = await electronApp.firstWindow();
  window.on('console', (msg) => {
    const text = msg.text();
    // The main window is served over file://, which cannot carry the `Document-Policy: js-profiling` header,
    // so the Browser SDK profiler always fails to start there. That failure is expected in this setup;
    // drop its noise (the bridge windows that actually profile are served over app:// / http with the header).
    if (text.includes('js-profiling') || text.includes('Profiler startup failed')) {
      return;
    }
    console.log('Browser console:', text);
  });
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

export async function launchDeferredInitApp(intake: Intake, userDataDir: string): Promise<ElectronApplication> {
  return launchApp(
    intake,
    userDataDir,
    null,
    {
      allowedWebViewHosts: ['deferred-init.example.com'],
      defaultPrivacyLevel: 'allow',
    },
    { DD_E2E_DEFER_INIT: '1' }
  );
}

export async function createUserDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'electron-sdk-e2e-'));
}

export async function cleanupUserDataDir(userDataDir: string): Promise<void> {
  await rm(userDataDir, { recursive: true, force: true });
}

export { expect } from '@playwright/test';
