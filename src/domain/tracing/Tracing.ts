import { createRequire } from 'node:module';
import { addError } from '../telemetry';
import { patchFetchContext } from './tracingPatches';

// Support both CJS (__filename) and ESM (import.meta.url) contexts
const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

interface ExporterWithFlush {
  flush(done: () => void): void;
}

interface TracerInternals {
  _tracer?: { _exporter?: unknown };
}

export class Tracing {
  enabled = false;
  private exporter: ExporterWithFlush | undefined;

  constructor() {
    try {
      const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

      // tracer.init() is a no-op if already called by instrument.ts.
      // Service/env/version are set per-span by SpanProcessor.
      tracer.use('http');

      patchFetchContext(tracer);

      // TODO(RUM-16445) discuss a more reliable way to flush the exporter
      const internalExporter = (tracer as unknown as TracerInternals)._tracer?._exporter;
      if (internalExporter && typeof (internalExporter as ExporterWithFlush).flush === 'function') {
        this.exporter = internalExporter as ExporterWithFlush;
      }

      this.enabled = true;
    } catch (error) {
      addError(error);
    }
  }

  // dd-trace's electron exporter batches spans on a flushInterval (2s by default).
  // Flushing it before the SDK transport ensures any pending HTTP spans become RUM
  // resource events synchronously, so _flushTransport() captures them in one shot.
  async flush(): Promise<void> {
    if (!this.exporter) return;
    await new Promise<void>((resolve) => this.exporter!.flush(resolve));
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  stop(): void {}
}
