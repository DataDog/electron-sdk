import { TelemetryErrorEvent } from './telemetryEvent.types';
import { RecursivePartial } from '@datadog/browser-core';

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
