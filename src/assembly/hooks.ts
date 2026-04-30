import { combine, DISCARDED, SKIPPED, type RecursivePartial, type TimeStamp } from '@datadog/browser-core';
import type { RumEvent } from '../domain/rum';
import type { TelemetryEvent } from '../domain/telemetry';

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

export type SpanMeta = Record<string, string>;

type AssembleCallback<Params, Result> = (params: Params) => Result | typeof DISCARDED | typeof SKIPPED;

/**
 * Single-purpose hook: register callbacks and trigger them with combine/DISCARDED/SKIPPED semantics.
 * Same behavior as browser-core's abstractHooks, without the HookNames constraint.
 */
function createAssembleHook<Params, Result>() {
  const callbacks: AssembleCallback<Params, Result>[] = [];

  return {
    register: (callback: AssembleCallback<Params, Result>) => {
      callbacks.push(callback);
      return {
        unregister: () => {
          const index = callbacks.indexOf(callback);
          if (index !== -1) {
            callbacks.splice(index, 1);
          }
        },
      };
    },
    trigger: (params: Params): Result | typeof DISCARDED | undefined => {
      const results: Result[] = [];

      for (const callback of callbacks) {
        const result = callback(params);
        if (result === DISCARDED) {
          return DISCARDED;
        }
        if (result === SKIPPED) {
          continue;
        }
        results.push(result);
      }

      return combine(...(results as [unknown, unknown])) as Result;
    },
  };
}

export type FormatHooks = ReturnType<typeof createFormatHooks>;

export function createFormatHooks() {
  const rumHook = createAssembleHook<RumAssembleParams, RecursivePartial<RumEvent>>();
  const telemetryHook = createAssembleHook<TelemetryAssembleParams, RecursivePartial<TelemetryEvent>>();
  const spanHook = createAssembleHook<SpanAssembleParams, SpanMeta>();

  return {
    registerRum: rumHook.register,
    registerTelemetry: telemetryHook.register,
    registerSpan: spanHook.register,
    triggerRum: rumHook.trigger,
    triggerTelemetry: telemetryHook.trigger,
    triggerSpan: spanHook.trigger,
  };
}
