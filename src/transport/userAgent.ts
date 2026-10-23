import os from 'node:os';

/**
 * Returns a User-Agent string for HTTP requests to Datadog intake.
 *
 * Format: `(OS details) Electron/X Chrome/X Node/X`
 */
export function getUserAgent(): string {
  return [
    `(${getOSUserAgentPart()})`,
    `Electron/${process.versions.electron}`,
    `Chrome/${process.versions.chrome}`,
    `Node/${process.versions.node}`,
  ].join(' ');
}

function getOSUserAgentPart(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    const version = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
    if (!version) {
      return `${platform}; ${arch}`;
    }

    let normalized = version;
    if (normalized.split('.').length === 2) {
      normalized += '.0';
    }

    // "Intel" is kept even on Apple Silicon, following Chrome/Chromium UA convention
    return `Macintosh; Intel Mac OS X ${normalized.replace(/\./g, '_')}`;
  }

  if (platform === 'win32') {
    const ntVersion = os.release().split('.').slice(0, 2).join('.');
    const archUA = arch === 'x64' ? 'Win64; x64' : arch === 'arm64' ? 'ARM64' : arch;
    return `Windows NT ${ntVersion}; ${archUA}`;
  }

  if (platform === 'linux') {
    const archUA = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
    return `X11; Linux ${archUA}`;
  }

  return `${platform}; ${arch}`;
}
