/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@datadog/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Initializes dd-trace with the electron exporter, then:
 * - patches BrowserWindow to inject the bridge preload
 * - wraps ipcMain and webContents for IPC span instrumentation
 * - patches net to http span instrumentation
 *
 * Note: Bundlers may break the import order dd-trace needs. Use the bundler
 * plugins provided by the SDK to ensure correct behavior:
 * - Vite: datadogVitePlugin from '@datadog/electron-sdk/vite-plugin'
 * - Webpack: DatadogWebpackPlugin from '@datadog/electron-sdk/webpack-plugin'
 */
// TODO remove when dd-trace electron plugin is dropped
import ddTrace from './instrument-prelude';
import { display } from '../tools/display';
import { createRequire } from 'node:module';
import { instrumentElectron } from '../instrument/instrumentElectron';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

try {
  ddTrace.init({
    // TODO: remove cast when dd-trace releases a fix
    experimental: { exporter: 'electron' as 'datadog' },
  });
} catch {
  display.warn('dd-trace not found, monitoring will not work');
}

try {
  const electron = _require('electron') as string | typeof import('electron');

  // In plain Node, 'electron' exports the binary path string — skip patching there.
  if (typeof electron !== 'string') {
    instrumentElectron(electron);
  }
} catch {
  // electron not available (e.g. during unit testing) — skip patching
}
