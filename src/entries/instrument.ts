/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@datadog/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Initializes dd-trace with the electron exporter.
 *
 * Note: Bundlers may break the import order dd-trace needs. Use the bundler
 * plugins provided by the SDK to ensure correct behavior:
 * - Vite: datadogVitePlugin from '@datadog/electron-sdk/vite-plugin'
 * - Webpack: DatadogWebpackPlugin from '@datadog/electron-sdk/webpack-plugin'
 */
// TODO remove when dd-trace electron plugin is dropped
import ddTrace from './instrument-prelude';
import { displayWarn } from '../tools/display';

try {
  ddTrace.init({
    // TODO: remove cast when dd-trace releases a fix
    experimental: { exporter: 'electron' as 'datadog' },
  });
} catch {
  displayWarn('dd-trace not found, monitoring will not work');
}
