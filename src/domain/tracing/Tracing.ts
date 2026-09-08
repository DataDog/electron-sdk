import { createRequire } from 'node:module';
import type { SamplingRule } from 'dd-trace-electron';
import { addError } from '../telemetry';
import type { Configuration, TraceSamplingRule } from '../../config';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

interface ExporterWithFlush {
  flush(done: () => void): void;
}

interface TracerInternals {
  _tracer?: {
    _exporter?: unknown;
  };
  _tracingInitialized?: boolean;
}

/**
 * dd-trace-electron's own version, read from its manifest since the tracer does not expose one.
 *
 * Deliberately soft: the version is only telemetry, so a package that hides its manifest behind an
 * `exports` map must not take tracing down with it.
 */
function readTracerVersion(requireFn: NodeRequire): string | undefined {
  try {
    return (requireFn('dd-trace-electron/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export class Tracing {
  enabled = false;
  /**
   * Whether dd-trace-electron's own init() actually ran, per `_tracingInitialized` — a stronger
   * signal than
   * `enabled`, which only reflects that the package loaded. Reserved for telemetry reporting (e.g.
   * `use_tracing`), so a future tracer internals rename degrades reporting accuracy rather than
   * disabling `SpanProcessor` registration, which stays gated on `enabled`.
   */
  telemetryInitialized = false;
  version: string | undefined;
  private exporter: ExporterWithFlush | undefined;

  constructor(config: Configuration, requireFn: NodeRequire = _require) {
    try {
      const tracer = (requireFn('dd-trace-electron') as { default: typeof import('dd-trace-electron').default })
        .default;

      tracer.init({
        experimental: { exporter: 'electron' as 'datadog' },
        ...(config.env !== undefined ? { env: config.env } : {}),
        ...(config.traceSamplingRules.length > 0
          ? {
              samplingRules: toDdTraceSamplingRules(config.traceSamplingRules),
              rateLimit: -1,
            }
          : {}),
      });

      // Service/env/version are set per-span by SpanProcessor.
      // TODO(RUM-16445) discuss a more reliable way to flush the exporter
      const internals = tracer as unknown as TracerInternals;
      const internalExporter = internals._tracer?._exporter;
      if (internalExporter && typeof (internalExporter as ExporterWithFlush).flush === 'function') {
        this.exporter = internalExporter as ExporterWithFlush;
      }

      this.enabled = true;
      this.telemetryInitialized = internals._tracingInitialized === true;
      this.version = readTracerVersion(requireFn);
    } catch (error) {
      addError(error);
    }
  }

  static isTraceSampled(trace: { metrics: Record<string, number> }[]): boolean {
    return !trace.some((span) => {
      const priority = span.metrics['_sampling_priority_v1'];
      return priority !== undefined && priority <= 0;
    });
  }

  // dd-trace-electron's exporter batches spans on a flushInterval (2s by default).
  // Flushing it before the SDK transport ensures any pending HTTP spans become RUM resource events synchronously,
  // so _flushTransport() captures them in one shot.
  async flush(): Promise<void> {
    if (!this.exporter) {
      return;
    }
    await new Promise<void>((resolve) => this.exporter!.flush(resolve));
  }
}

// Electron exposes percentages while dd-trace-electron expects rates between 0 and 1.
function toDdTraceSamplingRules(rules: TraceSamplingRule[]): SamplingRule[] {
  return rules.map(({ sampleRate, ...rule }) => ({ ...rule, sampleRate: sampleRate / 100 }));
}
