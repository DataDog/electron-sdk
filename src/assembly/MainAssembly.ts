import { timeStampNow } from '@datadog/js-core/time';
import { combine, type RecursivePartial } from '@datadog/js-core/util';
import { DISCARDED } from '@datadog/js-core/assembly';
import {
  EventFormat,
  EventKind,
  EventManager,
  EventSource,
  EventTrack,
  type RawEvent,
  type RawProfileEvent,
  type ServerEvent,
} from '../event';
import type { FormatHooks } from './hooks';
import { RumEvent } from '../domain/rum';
import { TelemetryEvent } from '../domain/telemetry';

// Raw events assembled through the standard main-process hook pipeline.
type StandardRawEvent = Exclude<RawEvent, RawProfileEvent>;

/**
 * Transforms main-process RawEvents into ServerEvents by enriching them with
 * contextual attributes (session, application, view, etc.) via format hooks.
 */
export class MainAssembly {
  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks
  ) {
    this.eventManager.registerHandler<StandardRawEvent>({
      canHandle: (event): event is StandardRawEvent =>
        event.kind === EventKind.RAW && event.format !== EventFormat.PROFILE,
      handle: (event, notify) => {
        const result = this.assembleMainProcessEvent(event);
        if (result !== DISCARDED) {
          notify(result);
        }
      },
    });
  }

  private assembleMainProcessEvent(event: StandardRawEvent): ServerEvent | DISCARDED {
    const startTime = event.startTime ?? timeStampNow();
    const source = EventSource.MAIN;

    if (event.format === EventFormat.RUM) {
      const hookResult = this.hooks.triggerRum({
        eventType: event.data.type,
        startTime,
        source,
      });
      if (hookResult !== DISCARDED) {
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          source: EventSource.MAIN,
          data: assembleData<RumEvent>(event.data, hookResult),
        };
      }
    }

    if (event.format === EventFormat.TELEMETRY) {
      const hookResult = this.hooks.triggerTelemetry({ startTime, source });
      if (hookResult !== DISCARDED) {
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          source: EventSource.MAIN,
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
