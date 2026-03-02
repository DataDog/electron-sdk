import { combine, DISCARDED } from '@datadog/browser-core';
import { EventManager, EventFormat, EventKind, EventTrack, type RawEvent, type ServerEvent } from '../event';
import type { FormatHooks, RumEventType } from './hooks';

export class Assembly {
  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks
  ) {
    this.eventManager.registerHandler<RawEvent>({
      canHandle: (event) => event.kind === EventKind.RAW,
      handle: (event, notify) => {
        const startTime = Date.now();
        let hookResult;

        if (event.format === EventFormat.TELEMETRY) {
          hookResult = this.hooks.triggerTelemetry({ startTime });
        } else {
          hookResult = this.hooks.triggerRum({
            eventType: (event.data as { type: RumEventType }).type,
            startTime,
          });
        }

        if (hookResult === DISCARDED) {
          return;
        }

        const serverEvent: ServerEvent = {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          data: hookResult ? combine(event.data, hookResult) : event.data,
        };
        notify(serverEvent);
      },
    });
  }
}
