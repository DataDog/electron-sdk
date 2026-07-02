import { resolvePreloadPath, patchBrowserWindow } from './browserWindow';
import { patchIpcMain, patchWebContents } from './ipc';
import { patchNet } from './net';

// Applied at most once per electron module. The instrumentation entry point can be evaluated twice
// in the same process: bundler plugins inject a CJS banner that requires it (instrument.cjs) while
// an app following the README also `import '@datadog/electron-sdk/instrument'` (instrument.mjs).
// Node keeps CJS and ESM as separate module instances, so a module-level flag would not be shared.
// The `electron` module is a native singleton shared by both copies, so we flag it directly —
// without the guard the patches would wrap ipcMain/net/webContents twice (duplicate nested spans)
// and register the bridge preload twice (duplicate renderer RUM events).
const INSTRUMENTED = Symbol.for('@datadog/electron-sdk:instrumented');

/**
 * Instruments the Electron main-process APIs: injects the bridge preload via BrowserWindow, wraps
 * ipcMain/webContents for IPC spans, and patches net for outgoing HTTP spans. Idempotent — a second
 * call on the same electron module is a no-op.
 */
export function instrumentElectron(electron: typeof import('electron')): void {
  const guarded = electron as unknown as Record<symbol, boolean>;
  if (guarded[INSTRUMENTED]) {
    return;
  }
  guarded[INSTRUMENTED] = true;

  const preloadPath = resolvePreloadPath();
  if (preloadPath) {
    try {
      patchBrowserWindow(electron, preloadPath);
    } catch {
      // skip if BrowserWindow is not patchable in this context
    }
  }
  if (electron.ipcMain) {
    patchIpcMain(electron.ipcMain);
  }
  if (electron.BrowserWindow) {
    patchWebContents(electron.BrowserWindow);
  }
  if (electron.net) {
    patchNet(electron.net);
  }
}
