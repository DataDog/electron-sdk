import type { ElectronApplication } from '@playwright/test';

/** Ensures a compatibility job launched the Electron binary declared by its target. */
export async function assertExpectedElectronVersion(electronApp: ElectronApplication): Promise<void> {
  const expectedVersion = process.env.DD_ELECTRON_EXPECTED_VERSION;
  if (!expectedVersion) return;

  const actualVersion = await electronApp.evaluate(() => process.versions.electron);
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected Electron ${expectedVersion}, but the launched application uses ${actualVersion}.`);
  }
}
