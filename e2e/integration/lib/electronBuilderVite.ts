import { join } from 'node:path';
import type { IntegrationVariant } from '../../playwright.config';

/**
 * Returns the path to the ASAR archive produced by electron-builder for the
 * electron-builder-vite fixture app. Handles per-platform and per-arch output
 * directory naming conventions used by electron-builder.
 */
export function getElectronBuilderViteArchivePath(appDir: string, variant: IntegrationVariant): string {
  const workflow = variant === 'plugin-copy' ? 'plugin-copy' : 'default-copy';
  const productName = variant === 'plugin-copy' ? 'electron-builder-vite-plugin-copy' : 'electron-builder-vite';

  if (process.platform === 'darwin') {
    const outputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return join(appDir, 'out', workflow, outputDirectory, `${productName}.app`, 'Contents', 'Resources', 'app.asar');
  }

  const outputDirectory = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked';
  return join(appDir, 'out', workflow, outputDirectory, 'resources', 'app.asar');
}
