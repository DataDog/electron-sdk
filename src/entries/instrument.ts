/**
 * Instrumentation entry point — must be imported before 'electron'.
 *
 * Usage:
 *   import '@datadog/electron-sdk/instrument';
 *   import { app, BrowserWindow } from 'electron';
 *
 * Initializes dd-trace with the electron exporter so it can hook
 * require('electron') and wrap BrowserWindow for automatic preload injection.
 */
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tracer = (require('dd-trace') as { default: typeof import('dd-trace').default }).default;

  tracer.init({
    experimental: { exporter: 'electron' },
  });
} catch {
  // dd-trace not available — no-op
}
