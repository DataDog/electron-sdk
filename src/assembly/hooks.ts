import { createHook, type RecursivePartial } from '@datadog/browser-core';
import type { TimeStamp } from '@datadog/js-core/time';
import type { RumEvent } from '../domain/rum';
import type { TelemetryEvent } from '../domain/telemetry';
import { RawSpanData } from '../domain/tracing/rawTracingData.types';

export type RumEventType = RumEvent['type'];

export interface RumAssembleParams {
  eventType: RumEventType;
  startTime: TimeStamp;
}

export interface TelemetryAssembleParams {
  startTime: TimeStamp;
}

export interface SpanAssembleParams {
  startTime: TimeStamp;
}

export type FormatHooks = ReturnType<typeof createFormatHooks>;

export function createFormatHooks() {
  const rumHook = createHook<RumAssembleParams, RecursivePartial<RumEvent>>();
  const telemetryHook = createHook<TelemetryAssembleParams, RecursivePartial<TelemetryEvent>>();
  const spanHook = createHook<SpanAssembleParams, RecursivePartial<RawSpanData>>();

  return {
    registerRum: rumHook.register,
    registerTelemetry: telemetryHook.register,
    registerSpan: spanHook.register,
    triggerRum: rumHook.trigger,
    triggerTelemetry: telemetryHook.trigger,
    triggerSpan: spanHook.trigger,
  };
}
