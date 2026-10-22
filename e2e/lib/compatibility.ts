import type { ElectronApplication } from '@playwright/test';
import { join } from 'node:path';
import compatibilityConfig from '../compatibility/config.json';

/** Resolves the selected target for fixtures, project selection, and version assertions. */
export function getCompatibilityRun() {
  const id = process.env.DD_ELECTRON_COMPATIBILITY_TARGET;
  if (!id) return;

  const target = compatibilityConfig.targets.find((target) => target.id === id);
  if (!target) throw new Error(`Unknown compatibility target: ${id}.`);
  return { target, root: join(__dirname, '../compatibility/generated', target.id) };
}

/** Ensures a compatibility job launched the Electron binary declared by its target. */
export async function assertExpectedElectronVersion(electronApp: ElectronApplication): Promise<void> {
  const expectedVersion = getCompatibilityRun()?.target.version;
  if (!expectedVersion) return;

  const actualVersion = await electronApp.evaluate(() => process.versions.electron);
  if (actualVersion !== expectedVersion) {
    throw new Error(`Expected Electron ${expectedVersion}, but the launched application uses ${actualVersion}.`);
  }
}
