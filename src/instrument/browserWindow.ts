import { createRequire } from 'node:module';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

function resolvePackage(id: string): string {
  return _require.resolve(id);
}

export function resolvePreloadPath(_resolvePackage = resolvePackage): string | undefined {
  try {
    return _resolvePackage('@datadog/electron-sdk/electron/preload');
  } catch {
    console.warn('[datadog] Could not resolve preload script - BrowserWindow injection skipped');
    return undefined;
  }
}

interface NativeBrowserWindow {
  webContents: { session: { registerPreloadScript: (opts: { type: string; filePath: string }) => void } };
}

export function patchBrowserWindow(electron: typeof import('electron'), preloadPath: string): void {
  const OriginalBrowserWindow = electron.BrowserWindow;

  class DatadogBrowserWindow extends OriginalBrowserWindow {
    constructor(options?: Electron.BrowserWindowConstructorOptions) {
      // BrowserWindow doesn't support true subclassing (native code) - super()
      // returns the native instance, not `this`.
      const win = super(options ?? {}) as unknown as NativeBrowserWindow;
      win.webContents.session.registerPreloadScript({ type: 'frame', filePath: preloadPath });
      return win as unknown as DatadogBrowserWindow;
    }
  }

  Object.assign(DatadogBrowserWindow, OriginalBrowserWindow);
  (electron as { BrowserWindow: unknown }).BrowserWindow = DatadogBrowserWindow;
}
