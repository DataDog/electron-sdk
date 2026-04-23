import { addError } from '../telemetry';

export class Tracing {
  enabled = false;

  constructor() {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tracer = (require('dd-trace') as { default: typeof import('dd-trace').default }).default;

      // dd-trace is initialized early via @datadog/electron-sdk/instrument (before require('electron')).
      // tracer.init() is a no-op if already initialized, so we only configure plugins here.
      // Service/env/version are not needed on the tracer — the SDK's Assembly hooks
      // enrich RUM events with those values from the SDK config.
      tracer.use('electron');
      tracer.use('http');

      this.enabled = true;
    } catch (error) {
      addError(error);
    }
  }
}
