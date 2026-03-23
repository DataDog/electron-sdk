import { combine, DISCARDED, timeStampNow, type RecursivePartial } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventTrack, type RawEvent, ServerEvent } from '../event';
import type { FormatHooks } from './hooks';
import { RumEvent } from '../domain/rum';
import { TelemetryEvent } from '../domain/telemetry';

export class Assembly {
  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks
  ) {
    this.eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event, notify) => {
        const result = this.assembleToServerEvent(event);
        if (result !== DISCARDED) {
          notify(result);
        }
      },
    });
  }

  private assembleToServerEvent(event: RawEvent): ServerEvent | DISCARDED {
    const startTime = event.startTime ?? timeStampNow();

    if (event.format === EventFormat.RUM) {
      const hookResult = this.hooks.triggerRum({
        eventType: event.data.type,
        startTime,
      });
      if (hookResult !== DISCARDED) {
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          data: assembleData<RumEvent>(event.data, hookResult),
        };
      }
    }

    if (event.format === EventFormat.TELEMETRY) {
      const hookResult = this.hooks.triggerTelemetry({ startTime });
      if (hookResult !== DISCARDED) {
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          data: assembleData<TelemetryEvent>(event.data, hookResult),
        };
      }
    }

    return DISCARDED;
  }
}

function assembleData<T>(rawData: unknown, hookResult: RecursivePartial<T> | undefined): T {
  return (hookResult ? combine(hookResult, rawData) : rawData) as T;
}
