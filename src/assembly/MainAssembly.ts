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
import type { FormatHooks, RumEventType } from './hooks';
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

    if (event.format === EventFormat.RUM && (isRumEventType(event.data.type) || event.data.type === 'process')) {
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

// The `satisfies` constraint has two roles:
// - `Record<RumEventType, 1>` key exhaustiveness: every RumEventType variant must be present (compile error if one is missing)
// - values typed as `RumEventType[]`: no string outside the union can be added
// Together they keep the type guard sound when RumEvent schema changes.
const RUM_EVENT_TYPES = new Set<RumEventType>(
  Object.keys({
    action: 1,
    error: 1,
    long_task: 1,
    resource: 1,
    transition: 1,
    view: 1,
    view_update: 1,
    vital: 1,
  } satisfies Record<RumEventType, 1>) as RumEventType[]
);

function isRumEventType(type: string): type is RumEventType {
  return RUM_EVENT_TYPES.has(type as RumEventType);
}
