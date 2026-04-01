import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Intake } from '../../lib/intake';
import type { IntegrationApp, IntegrationMode } from '../../playwright.config';
import type { InitConfiguration } from '@datadog/electron-sdk';

export interface IntegrationFixtures {
  /** The integration app name, set via Playwright project `use` config. */
  app: IntegrationApp;
  /** The test mode (dev or packaged), set via Playwright project `use` config. */
  mode: IntegrationMode;
  /** Local HTTP intake server capturing RUM events. */
  intake: Intake;
  /** Playwright handle for the running Electron application. */
  electronApp: ElectronApplication;
  /** The app's first renderer window. Auto-setup before each test. */
  window: Page;
}

export const test = base.extend<IntegrationFixtures>({
  app: ['' as IntegrationApp, { option: true }],
  mode: ['' as IntegrationMode, { option: true }],

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

  electronApp: async ({ app, mode, intake }, use) => {
    const appDir = join(__dirname, '../apps', app);
    const electronApp = await launchApp(appDir, mode, intake);
    await use(electronApp);
    await electronApp.close();
  },

  window: [
    async ({ electronApp }, use) => {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('load');
      // Small buffer for the SDK and browser-rum to initialize
      await window.waitForTimeout(500);
      await use(window);
    },
    { auto: true },
  ],
});

/**
 * Launches the integration app and returns the ElectronApplication handle.
 * Call this directly in tests that need to control the app lifecycle (e.g. crash tests).
 */
export async function launchApp(appDir: string, mode: IntegrationMode, intake: Intake): Promise<ElectronApplication> {
  const config = buildSdkConfig(intake);

  if (mode === 'packaged') {
    return electron.launch({
      executablePath: findPackagedBinary(appDir),
      env: { ...process.env, DD_SDK_CONFIG: JSON.stringify(config) } as Record<string, string>,
    });
  }

  // Dev mode: launch electron directly against the webpack/vite build output.
  // The electron binary is resolved from the app's own node_modules so it matches
  // the app's declared peer dependency version.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronPath = require(join(appDir, 'node_modules/electron')) as string;
  const mainScript = findDevMainScript(appDir);

  return electron.launch({
    executablePath: electronPath,
    args: [mainScript],
    env: { ...process.env, DD_SDK_CONFIG: JSON.stringify(config) } as Record<string, string>,
  });
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
    allowedWebViewHosts: [],
  };
}

/**
 * Returns the compiled main script path for dev-mode launch.
 * Each integration app declares its dev main entry in `package.json` under
 * `integration.devMain` — a path relative to the app directory.
 */
function findDevMainScript(appDir: string): string {
  const pkgPath = join(appDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { integration?: { devMain?: string } };
  const devMain = pkg.integration?.devMain;

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
function findPackagedBinary(appDir: string): string {
  const pkgPath = join(appDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    integration?: { packagedBinary?: Record<string, string> };
  };
  const packagedBinary = pkg.integration?.packagedBinary;

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

export { expect } from '@playwright/test';
