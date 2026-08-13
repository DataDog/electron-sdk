import { app, screen } from 'electron';
import { resolveUploadFrequency, type Configuration } from '../../config';
import { addConfiguration } from './Telemetry';
import type { RawTelemetryConfigurationData } from './rawTelemetryData.types';

/**
 * Runtime facts that are not part of {@link Configuration} but belong in the report.
 */
export interface ConfigurationTelemetryContext {
  /** Whether dd-trace loaded, i.e. whether spans are collected at all. */
  useTracing: boolean;
  /** dd-trace's version, when it could be read. */
  tracerVersion?: string;
}

/**
 * Report the resolved SDK configuration, once per `init()`.
 *
 * Reports *effective* values rather than what the customer passed: an unset option still produces
 * behaviour, and telemetry should describe what the SDK does. Sample rates nested under another rate
 * are the exception — they are reported as configured, matching the other SDKs, so
 * `session_replay_sample_rate` is the rate applied to sampled sessions rather than the combined one.
 * Options with no schema field are omitted rather than forced into an unrelated one — see
 * {@link buildConfigurationTelemetry}.
 */
export function reportConfiguration(configuration: Configuration, context: ConfigurationTelemetryContext): void {
  addConfiguration(buildConfigurationTelemetry(configuration, context));
}

function buildConfigurationTelemetry(
  configuration: Configuration,
  { useTracing, tracerVersion }: ConfigurationTelemetryContext
): RawTelemetryConfigurationData {
  return {
    session_sample_rate: configuration.sessionSampleRate,
    session_replay_sample_rate: configuration.sessionReplaySampleRate,
    telemetry_sample_rate: configuration.telemetrySampleRate,
    telemetry_configuration_sample_rate: configuration.telemetryConfigurationSampleRate,
    telemetry_usage_sample_rate: configuration.telemetryUsageSampleRate,
    profiling_sample_rate: configuration.profilingSampleRate,
    default_privacy_level: configuration.defaultPrivacyLevel,
    use_proxy: configuration.proxy !== undefined,
    // Both fields carry the upload frequency, which is correct rather than redundant. The schema's
    // `batch_size` is a batch *window duration* in milliseconds (mobile sends `BatchSize.windowDurationMs`,
    // 3s/10s/35s). Electron seals the open batch and drains every pending one on the same tick, so the
    // accumulation window and the upload period are the same number by construction. The SDK's own
    // `batchSize` option is a byte threshold — a different axis with no schema field — so it is not
    // reported here; see `resolveBatchSize`. If window and upload period are ever decoupled
    // (RUM-18006), this stops being an alias and starts carrying the window on its own.
    batch_size: resolveUploadFrequency(configuration),
    batch_upload_frequency: resolveUploadFrequency(configuration),
    use_tracing: useTracing,
    // dd-trace is the only tracer the SDK integrates with, so the API is Datadog's whenever tracing is on.
    tracer_api: useTracing ? 'Datadog' : undefined,
    tracer_api_version: useTracing ? tracerVersion : undefined,
    // The main process owns collection; renderers report through the bridge, never via their own init().
    is_main_process: true,
    // ErrorCollection and CrashCollection are started unconditionally by RumCollection.
    track_errors: true,
    number_of_displays: resolveNumberOfDisplays(),
  };
}

/**
 * Display count, omitted when it cannot be read.
 *
 * A snapshot, not a lifetime value: displays are attached and removed while an app runs, and this
 * event is sent once per process. Electron's `screen` module throws before the app `ready` event and
 * `init()` is not required to run after it, so an early `init()` reports nothing rather than failing.
 */
function resolveNumberOfDisplays(): number | undefined {
  if (!app.isReady()) {
    return undefined;
  }
  return screen.getAllDisplays().length;
}
