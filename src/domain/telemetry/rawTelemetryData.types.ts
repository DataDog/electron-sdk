import type {
  TelemetryConfigurationEvent,
  TelemetryErrorEvent,
  TelemetryEvent,
  TelemetryUsageEvent,
} from './telemetryEvent.types';
import { type RecursivePartial } from '@datadog/js-core/util';

export type RawTelemetryData = RawTelemetryError | RawTelemetryConfiguration | RawTelemetryUsage;

/**
 * The kinds of telemetry a {@link TelemetryEvent} can report, i.e. its `telemetry.type` discriminator.
 *
 * Note that `'log'` is the schema's bucket for both `status: 'error'` and `status: 'debug'`.
 */
export type TelemetryType = NonNullable<TelemetryEvent['telemetry']['type']>;

/**
 * The {@link TelemetryType}s the SDK itself emits, used to sample and rate-limit per type.
 *
 * The SDK only emits errors, not debug logs, so the shared `'log'` bucket is one type today; adding
 * debug telemetry would make the two share a sample rate and a dedup namespace unless this is split.
 * Derived from the raw shapes rather than from {@link TelemetryType} so it stays the set the SDK
 * emits, which the schema can widen beyond.
 */
export type RawTelemetryType = RawTelemetryData['telemetry']['type'];

/** The SDK configuration reported by a configuration event. */
export type RawTelemetryConfigurationData = TelemetryConfigurationEvent['telemetry']['configuration'];

/** A single public-API usage reported by a usage event. */
export type RawTelemetryUsageData = TelemetryUsageEvent['telemetry']['usage'];

/** The message and error properties reported by an error event. */
export type RawTelemetryErrorData = Pick<TelemetryErrorEvent['telemetry'], 'status' | 'message' | 'error'>;

export interface RawTelemetryError extends RecursivePartial<TelemetryErrorEvent> {
  type: 'telemetry';
  // `type` is optional in the schema but required here, so `RawTelemetryData` narrows on it. The rest
  // is derived rather than restated so a schema change surfaces as a compile error.
  telemetry: RawTelemetryErrorData & { type: 'log' };
}

export interface RawTelemetryConfiguration extends RecursivePartial<TelemetryConfigurationEvent> {
  type: 'telemetry';
  telemetry: {
    type: 'configuration';
    configuration: RawTelemetryConfigurationData;
  };
}

export interface RawTelemetryUsage extends RecursivePartial<TelemetryUsageEvent> {
  type: 'telemetry';
  telemetry: {
    type: 'usage';
    usage: RawTelemetryUsageData;
  };
}
