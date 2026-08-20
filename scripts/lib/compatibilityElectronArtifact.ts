import { downloadArtifact } from '@electron/get';

import { getElectronDimension, type CompatibilityTarget } from './compatibility.ts';
import { printLog } from './executionUtils.ts';
import { RetryingFetchDownloader } from './retryingFetchDownloader.ts';

/** Downloads and verifies the target Electron ZIP before generated applications install it. */
export async function prefetchCompatibilityElectronArtifact(target: CompatibilityTarget): Promise<string> {
  const electron = getElectronDimension(target);
  const downloader = new RetryingFetchDownloader();

  printLog(`Prefetching Electron ${electron.version} for ${process.platform}/${process.arch}`);
  const artifactPath = await downloadArtifact({
    arch: process.arch,
    artifactName: 'electron',
    downloader,
    platform: process.platform,
    version: electron.version,
  });
  printLog(`Electron ${electron.version} is available in the standard cache at ${artifactPath}`);
  return artifactPath;
}
