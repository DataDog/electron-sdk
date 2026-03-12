import os from 'node:os';
import { execFile } from 'node:child_process';
import { app } from 'electron';
import { addError } from '../domain/telemetry';
import { ONE_SECOND } from '@datadog/browser-core';

let cachedUserAgent: Promise<string> | undefined;

/**
 * Returns a User-Agent string for HTTP requests to Datadog intake.
 *
 * Format: `AppName/Version (OS details) Electron/X Chrome/X Node/X`
 *
 * The result is computed once and cached for subsequent calls.
 */
export function getUserAgent(): Promise<string> {
  if (!cachedUserAgent) {
    cachedUserAgent = getOSUserAgentPart().then((osPart) =>
      [
        `${app.getName()}/${app.getVersion()}`,
        `(${osPart})`,
        `Electron/${process.versions.electron}`,
        `Chrome/${process.versions.chrome}`,
        `Node/${process.versions.node}`,
      ].join(' ')
    );
  }
  return cachedUserAgent;
}

function getOSUserAgentPart(): Promise<string> {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return new Promise((resolve) => {
      // Timeout prevents sw_vers from blocking the upload path if it hangs
      execFile('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: ONE_SECOND }, (error, stdout) => {
        if (error) {
          addError(error);
          resolve(`${platform}; ${arch}`);
          return;
        }

        let version = stdout.trim();
        if (version.split('.').length === 2) {
          version += '.0';
        }

        // "Intel" is kept even on Apple Silicon, following Chrome/Chromium UA convention
        resolve(`Macintosh; Intel Mac OS X ${version.replace(/\./g, '_')}`);
      });
    });
  }

  if (platform === 'win32') {
    const ntVersion = os.release().split('.').slice(0, 2).join('.');
    const archUA = arch === 'x64' || arch === 'arm64' ? 'Win64; x64' : arch;
    return Promise.resolve(`Windows NT ${ntVersion}; ${archUA}`);
  }

  if (platform === 'linux') {
    const archUA = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
    return Promise.resolve(`X11; Linux ${archUA}`);
  }

  return Promise.resolve(`${platform}; ${arch}`);
}

/** Reset cached user agent (for testing) */
export function resetUserAgentCache(): void {
  cachedUserAgent = undefined;
}
