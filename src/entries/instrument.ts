/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@datadog/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Loads the tracing runtime, then:
 * - patches BrowserWindow to inject the bridge preload
 * - wraps ipcMain and webContents for IPC span instrumentation
 * - patches net to http span instrumentation
 *
 * Note: Bundlers may break the import order needed for instrumentation. Use the bundler
 * plugins provided by the SDK to ensure correct behavior:
 * - Vite: datadogVitePlugin from '@datadog/electron-sdk/vite-plugin'
 * - Webpack: DatadogWebpackPlugin from '@datadog/electron-sdk/webpack-plugin'
 */
import { createRequire } from 'node:module';
import './instrument-prelude';
import { instrumentElectron } from '../instrument/instrumentElectron';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

try {
  const electron = _require('electron') as string | typeof import('electron');

  // In plain Node, 'electron' exports the binary path string — skip patching there.
  if (typeof electron !== 'string') {
    instrumentElectron(electron);
  }
} catch {
  // electron not available (e.g. during unit testing) — skip patching
}
