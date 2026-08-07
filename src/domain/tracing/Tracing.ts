import { createRequire } from 'node:module';
import { addError } from '../telemetry';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

interface ExporterWithFlush {
  flush(done: () => void): void;
}

interface TracerInternals {
  _tracer?: { _exporter?: unknown };
}

/**
 * dd-trace's own version, read from its manifest since the tracer does not expose one.
 *
 * Deliberately soft: the version is only telemetry, so a package that hides its manifest behind an
 * `exports` map must not take tracing down with it.
 */
function readTracerVersion(): string | undefined {
  try {
    return (_require('dd-trace/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export class Tracing {
  enabled = false;
  version: string | undefined;
  private exporter: ExporterWithFlush | undefined;

  constructor() {
    try {
      const tracer = (_require('dd-trace') as { default: typeof import('dd-trace').default }).default;

      // tracer.init() is a no-op if already called by instrument.ts.
      // Service/env/version are set per-span by SpanProcessor.
      // TODO(RUM-16445) discuss a more reliable way to flush the exporter
      const internalExporter = (tracer as unknown as TracerInternals)._tracer?._exporter;
      if (internalExporter && typeof (internalExporter as ExporterWithFlush).flush === 'function') {
        this.exporter = internalExporter as ExporterWithFlush;
      }

      this.enabled = true;
      this.version = readTracerVersion();
    } catch (error) {
      addError(error);
    }
  }

  // dd-trace's electron exporter batches spans on a flushInterval (2s by default).
  // Flushing it before the SDK transport ensures any pending HTTP spans become RUM resource events synchronously,
  // so _flushTransport() captures them in one shot.
  async flush(): Promise<void> {
    if (!this.exporter) {
      return;
    }
    await new Promise<void>((resolve) => this.exporter!.flush(resolve));
  }
}
