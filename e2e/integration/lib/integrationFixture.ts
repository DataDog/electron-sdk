import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Intake } from '../../lib/intake';
import { TestServer } from '../../lib/testServer';
import { assertExpectedElectronVersion } from '../../lib/compatibility';
import type { IntegrationApp, IntegrationMode, IntegrationVariant } from '../../playwright.config';
import type { InitConfiguration } from '@datadog/electron-sdk';

const compatibilityRoot = process.env.DD_ELECTRON_COMPATIBILITY_ROOT;
const integrationAppsDirectory = compatibilityRoot
  ? join(compatibilityRoot, 'integration-apps')
  : join(__dirname, '../apps');

export function getIntegrationAppDirectory(app: IntegrationApp, variant: IntegrationVariant): string {
  const appDirectory = join(integrationAppsDirectory, app);
  return compatibilityRoot ? join(appDirectory, variant) : appDirectory;
}

export interface IntegrationFixtures {
  /** The integration app name, set via Playwright project `use` config. */
  app: IntegrationApp;
  /** The test mode (dev or packaged), set via Playwright project `use` config. */
  mode: IntegrationMode;
  /** Optional build/package variant for an integration app. */
  variant: IntegrationVariant;
  /** Local HTTP intake server capturing RUM events. */
  intake: Intake;
  /** Local HTTP server used as a controllable destination for outbound requests. */
  testServer: TestServer;
  /** Playwright handle for the running Electron application. */
  electronApp: ElectronApplication;
  /** The app's first renderer window. Auto-setup before each test. */
  window: Page;
}

export const test = base.extend<IntegrationFixtures>({
  app: ['' as IntegrationApp, { option: true }],
  mode: ['' as IntegrationMode, { option: true }],
  variant: ['default', { option: true }],

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

  electronApp: async ({ app, mode, variant, intake }, use) => {
    const appDir = getIntegrationAppDirectory(app, variant);
    const userDataDir = await mkdtemp(join(tmpdir(), 'electron-sdk-integration-'));
    const electronApp = await launchApp(appDir, mode, intake, userDataDir);
    await use(electronApp);
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true });
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('load');
    // Small buffer for the SDK and browser-rum to initialize
    await window.waitForTimeout(500);
    await use(window);
  },
});

/**
 * Launches the integration app and returns the ElectronApplication handle.
 * Call this directly in tests that need to control the app lifecycle (e.g. crash tests).
 */
export async function launchApp(
  appDir: string,
  mode: IntegrationMode,
  intake: Intake,
  userDataDir: string
): Promise<ElectronApplication> {
  const config = buildSdkConfig(intake);
  const userDataArgs = [`--user-data-dir=${userDataDir}`];

  if (mode === 'packaged') {
    return launchAndAssertVersion(findPackagedBinary(appDir), userDataArgs, config);
  }

  // Dev mode: launch electron directly against the webpack/vite build output.
  // The electron binary is resolved from the app's own node_modules so it matches
  // the app's declared peer dependency version.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require(join(appDir, 'node_modules/electron')) as string;
  const mainScript = findDevMainScript(appDir);

  return launchAndAssertVersion(electronPath, [mainScript, ...userDataArgs], config);
}

async function launchAndAssertVersion(
  executablePath: string,
  args: string[],
  config: InitConfiguration
): Promise<ElectronApplication> {
  const electronApp = await electron.launch({
    executablePath,
    args,
    env: { ...process.env, DD_SDK_CONFIG: JSON.stringify(config) },
  });
  try {
    await assertExpectedElectronVersion(electronApp);
    return electronApp;
  } catch (error) {
    await electronApp.close();
    throw error;
  }
}

function buildSdkConfig(intake: Intake): InitConfiguration {
  return {
    site: 'datadoghq.com',
    proxy: `http://localhost:${intake.getPort()}/api/v2/rum`,
    clientToken: 'integration-test-token',
    service: 'integration-test-app',
    applicationId: 'integration-test-app-id',
    env: 'test',
    version: '1.0.0',
    telemetrySampleRate: 100,
    defaultPrivacyLevel: 'mask',
    allowedRendererHosts: ['*'],
  };
}

/**
 * Returns the compiled main script path for dev-mode launch.
 * Each integration app declares its dev main entry in `package.json` under
 * `integration.devMain` — a path relative to the app directory.
 */
export function findDevMainScript(appDir: string): string {
  const pkgPath = join(appDir, 'package.json');
  const integration = getIntegrationLaunchConfiguration(pkgPath);
  const devMain = integration.devMain;

  if (!devMain) {
    throw new Error(
      `No "integration.devMain" field in ${pkgPath}. ` +
        `Add it pointing to the compiled main script (e.g. ".webpack/{arch}/main/index.js").`
    );
  }

  const resolved = join(appDir, devMain.replace('{arch}', process.arch));
  if (!existsSync(resolved)) {
    throw new Error(`Dev main script not found at ${resolved}. Make sure to run yarn test:integration:init first.`);
  }

  return resolved;
}

/**
 * Finds the packaged Electron binary using the explicit `integration.packagedBinary` field
 * from the app's `package.json`. Supports per-platform paths with optional `{arch}` placeholder.
 *
 * Key resolution: `${platform}-${arch}` (e.g. "darwin-arm64") takes precedence over
 * `${platform}` (e.g. "darwin"), allowing arch-specific overrides where packagers use
 * different output directory names per arch (e.g. electron-builder: `mac-arm64` vs `mac`).
 */
export function findPackagedBinary(appDir: string): string {
  const pkgPath = join(appDir, 'package.json');
  const integration = getIntegrationLaunchConfiguration(pkgPath);
  const packagedBinary = integration.packagedBinary;

  if (!packagedBinary) {
    throw new Error(
      `No "integration.packagedBinary" field in ${pkgPath}. ` + `Add it with per-platform paths (darwin/linux/win32).`
    );
  }

  const platform = process.platform;
  const arch = process.arch;
  // Prefer platform+arch key (e.g. "darwin-arm64") over platform key (e.g. "darwin")
  const template = packagedBinary[`${platform}-${arch}`] ?? packagedBinary[platform];

  if (!template) {
    throw new Error(`No "integration.packagedBinary" entry for "${platform}-${arch}" or "${platform}" in ${pkgPath}.`);
  }

  const resolved = join(appDir, template.replace('{arch}', arch));

  if (!existsSync(resolved)) {
    throw new Error(`Packaged binary not found at ${resolved}. Run yarn test:integration:init first.`);
  }

  return resolved;
}

interface IntegrationLaunchConfiguration {
  devMain?: string;
  packagedBinary?: Record<string, string>;
}

function getIntegrationLaunchConfiguration(packageJsonPath: string): IntegrationLaunchConfiguration {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    integration?: IntegrationLaunchConfiguration;
  };
  const integration = pkg.integration;

  if (!integration) {
    throw new Error(`No "integration" field in ${packageJsonPath}.`);
  }
  return integration;
}

export { expect } from '@playwright/test';
