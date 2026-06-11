import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import preloadContent from 'preload-content';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

function resolvePackage(id: string): string {
  return _require.resolve(id);
}

export function resolvePreloadPath(_resolvePackage = resolvePackage): string | undefined {
  const hash = createHash('md5').update(preloadContent).digest('hex').slice(0, 8);
  const tmpPath = join(tmpdir(), `datadog-preload-${hash}.js`);

  try {
    writeFileSync(tmpPath, preloadContent, { flag: 'wx' });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      try {
        return _resolvePackage('@datadog/electron-sdk/electron/preload');
      } catch {
        console.warn('[datadog] Could not resolve preload script — BrowserWindow injection skipped');
        return undefined;
      }
    }
  }

  return tmpPath;
}

export function patchBrowserWindow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  electron: any,
  preloadPath: string
): void {
  const OriginalBrowserWindow = electron.BrowserWindow

  class DatadogBrowserWindow extends OriginalBrowserWindow {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(options?: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const win = super(options ?? {})
      // BrowserWindow doesn't support true subclassing (native code),
      // must return the native instance
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      win.webContents.session.registerPreloadScript({
        type: 'frame',
        filePath: preloadPath,
      })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return win
    }
  }

  Object.assign(DatadogBrowserWindow, OriginalBrowserWindow)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  electron.BrowserWindow = DatadogBrowserWindow
}
