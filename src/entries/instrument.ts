/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@datadog/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Initializes dd-trace with the electron exporter, then patches BrowserWindow
 * to inject the bridge preload and wraps ipcMain for IPC span instrumentation.
 *
 * Note: Bundlers may break the import order dd-trace needs. Use the bundler
 * plugins provided by the SDK to ensure correct behavior:
 * - Vite: datadogVitePlugin from '@datadog/electron-sdk/vite-plugin'
 * - Webpack: DatadogWebpackPlugin from '@datadog/electron-sdk/webpack-plugin'
 */
import { createRequire } from 'node:module';
import { resolvePreloadPath, patchBrowserWindow } from '../instrument/browserWindow';
import { patchIpcMain } from '../instrument/ipc';
import { patchNet } from '../instrument/net';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

try {
  const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

  tracer.init({
    // TODO: remove cast when dd-trace releases a fix
    experimental: { exporter: 'electron' as 'datadog' },
  });
} catch {
  console.warn('[datadog] dd-trace not found — monitoring will not work');
}

interface ElectronModule {
  ipcMain?: Electron.IpcMain;
  BrowserWindow?: typeof Electron.BrowserWindow;
  net?: Electron.Net;
}

try {
  const electron = _require('electron') as string | ElectronModule;

  // In plain Node, 'electron' exports the binary path string — skip patching there.
  if (typeof electron !== 'string') {
    const preloadPath = resolvePreloadPath();
    if (preloadPath) {
      try {
        patchBrowserWindow(electron as typeof import('electron'), preloadPath);
      } catch {
        // skip if BrowserWindow is not patchable in this context
      }
    }
    if (electron.ipcMain) {
      patchIpcMain(electron.ipcMain);
    }
    if (electron.net) {
      patchNet(electron.net);
    }
  }
} catch {
  // electron not available (e.g. during unit testing) — skip patching
}
