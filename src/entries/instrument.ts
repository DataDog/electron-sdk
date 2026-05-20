/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@datadog/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Initializes dd-trace with the electron exporter so it can hook
 * require('electron') and wrap BrowserWindow for automatic preload injection.
 *
 * Note: Bundlers may break the import order dd-trace needs. Use the bundler
 * plugins provided by the SDK to ensure correct behavior:
 * - Vite: datadogVitePlugin from '@datadog/electron-sdk/vite-plugin'
 * - Webpack: DatadogWebpackPlugin from '@datadog/electron-sdk/webpack-plugin'
 */
import { createRequire } from 'node:module';

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

try {
  const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

  tracer.init({
    experimental: { exporter: 'electron' },
  });
} catch {
  // dd-trace not available — no-op
}
