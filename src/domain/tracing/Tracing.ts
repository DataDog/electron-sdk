import { createRequire } from 'node:module';
import { addError } from '../telemetry';

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

export class Tracing {
  enabled = false;

  constructor() {
    try {
      const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

      // dd-trace is initialized early via @datadog/electron-sdk/instrument (before require('electron')).
      // tracer.init() is a no-op if already initialized, so we only configure plugins here.
      // Service/env/version are set by ResourceConverter on each span payload,
      // overriding dd-trace's defaults with the SDK config values.
      tracer.use('electron');
      tracer.use('http');

      this.enabled = true;
    } catch (error) {
      addError(error);
    }
  }
}
