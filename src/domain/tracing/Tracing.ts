import { createRequire } from 'node:module';
import { addError } from '../telemetry';
import type { Configuration, TraceSamplingRule } from '../../config';

const _require = typeof __filename !== 'undefined' ? require : createRequire(import.meta.url);

interface ExporterWithFlush {
  flush(done: () => void): void;
}

interface TracerInternals {
  _tracer?: {
    _exporter?: unknown;
    _prioritySampler?: {
      configure(env: string, config: { rules: DdTraceSamplingRule[]; rateLimit: number }): void;
    };
  };
  _tracingInitialized?: boolean;
}

interface DdTraceSamplingRule {
  sampleRate: number;
  name?: string;
  resource?: string;
  tags?: Record<string, string>;
}

/**
 * dd-trace's own version, read from its manifest since the tracer does not expose one.
 *
 * Deliberately soft: the version is only telemetry, so a package that hides its manifest behind an
 * `exports` map must not take tracing down with it.
 */
function readTracerVersion(requireFn: NodeRequire): string | undefined {
  try {
    return (requireFn('dd-trace/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export class Tracing {
  enabled = false;
  /**
   * Whether dd-trace's own init() actually ran, per `_tracingInitialized` — a stronger signal than
   * `enabled`, which only reflects that the package loaded. Reserved for telemetry reporting (e.g.
   * `use_tracing`), so a future dd-trace internals rename degrades reporting accuracy rather than
   * disabling `SpanProcessor` registration, which stays gated on `enabled`.
   */
  telemetryInitialized = false;
  version: string | undefined;
  private exporter: ExporterWithFlush | undefined;

  constructor(config: Configuration, requireFn: NodeRequire = _require) {
    try {
      const tracer = (requireFn('dd-trace') as { default: typeof import('dd-trace').default }).default;

      // tracer.init() is a no-op if already called by instrument.ts.
      // Service/env/version are set per-span by SpanProcessor.
      // TODO(RUM-16445) discuss a more reliable way to flush the exporter
      const internals = tracer as unknown as TracerInternals;
      const internalExporter = internals._tracer?._exporter;
      if (internalExporter && typeof (internalExporter as ExporterWithFlush).flush === 'function') {
        this.exporter = internalExporter as ExporterWithFlush;
      }

      if (config.traceSamplingRules.length > 0) {
        internals._tracer?._prioritySampler?.configure(config.env ?? '', {
          rules: toDdTraceSamplingRules(config.traceSamplingRules, config.service),
          rateLimit: -1,
        });
      }

      this.enabled = true;
      this.telemetryInitialized = internals._tracingInitialized === true;
      this.version = readTracerVersion(requireFn);
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

function toDdTraceSamplingRules(rules: TraceSamplingRule[], service: string): DdTraceSamplingRule[] {
  return rules.flatMap(({ service: servicePattern, sampleRate, ...rule }) => {
    if (servicePattern !== undefined && !matchesGlob(servicePattern, service)) {
      return [];
    }
    return [{ ...rule, sampleRate: sampleRate / 100 }];
  });
}

function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
