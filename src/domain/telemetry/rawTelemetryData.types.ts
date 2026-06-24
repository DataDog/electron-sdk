import { TelemetryErrorEvent } from './telemetryEvent.types';
import { type RecursivePartial } from '@datadog/js-core/util';

export type RawTelemetryData = RawTelemetryError;

export interface RawTelemetryError extends RecursivePartial<TelemetryErrorEvent> {
  type: 'telemetry';
  telemetry: {
    type: 'log';
    status: 'error';
    message: string;
    error?: { stack?: string; kind?: string };
  };
}
