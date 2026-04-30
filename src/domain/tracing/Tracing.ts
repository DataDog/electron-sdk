import { addError } from '../telemetry';

export class Tracing {
  enabled = false;

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tracer = (require('dd-trace') as { default: typeof import('dd-trace').default }).default;

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
