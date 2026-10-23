import { timeStampNow, type TimeStamp } from '@datadog/js-core/time';
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
  type RawReplayEvent,
  type ServerEvent,
} from '../event';
import type { FormatHooks } from './hooks';
import { MainRumEvent } from '../domain/rum';
import { TelemetryEvent } from '../domain/telemetry';
import { BeforeSend } from './BeforeSend';
import { getRumConsentTime } from './rumConsentTime';
import type { TrackingConsentState } from '../domain/tracking-consent';

// Raw events assembled through the standard main-process hook pipeline.
type StandardRawEvent = Exclude<RawEvent, RawProfileEvent | RawReplayEvent>;

/**
 * Transforms main-process RawEvents into ServerEvents by enriching them with
 * contextual attributes (session, application, view, etc.) via format hooks,
 * then applies beforeSendRum to fully assembled RUM events.
 */
export class MainAssembly {
  constructor(
    private eventManager: EventManager,
    private hooks: FormatHooks,
    private beforeSend: BeforeSend,
    private trackingConsentState: TrackingConsentState
  ) {
    this.eventManager.registerHandler<StandardRawEvent>({
      canHandle: (event): event is StandardRawEvent =>
        event.kind === EventKind.RAW && event.format !== EventFormat.PROFILE && event.format !== EventFormat.REPLAY,
      handle: (event, notify) => {
        const result = this.assembleMainProcessEvent(event);
        if (result !== DISCARDED) {
          notify(result);
        }
      },
    });
  }

  private assembleMainProcessEvent(event: StandardRawEvent): ServerEvent | DISCARDED {
    const processingTime = timeStampNow();
    const startTime = event.startTime ?? processingTime;
    const source = EventSource.MAIN;

    if (event.format === EventFormat.RUM) {
      // Deferred collectors can resolve capture-time consent before assembly. Keep an authorized
      // decision even if consent changed while export was delayed. Pending still needs to retain its
      // interval across the customer callback so a rejection followed by a same-millisecond grant
      // cannot resurrect the event.
      const resolveStorageConsent =
        event.storageConsent === undefined || event.storageConsent === 'pending'
          ? this.trackingConsentState.captureStorageConsent()
          : () => event.storageConsent;
      const hookResult = this.hooks.triggerRum({
        eventType: event.data.type,
        startTime,
        source,
      });
      if (hookResult !== DISCARDED) {
        const data = this.beforeSend.apply(
          assembleData<MainRumEvent>(event.data, hookResult as RecursivePartial<MainRumEvent> | undefined),
          'main'
        );
        if (!data) {
          return DISCARDED;
        }
        const storageConsent = resolveStorageConsent();
        if (storageConsent !== 'granted' && storageConsent !== 'pending') {
          return DISCARDED;
        }
        const consentTime = (event.consentTime as TimeStamp | undefined) ?? getRumConsentTime(data, processingTime);
        return {
          kind: EventKind.SERVER,
          track: EventTrack.RUM,
          source: EventSource.MAIN,
          data,
          ...(event.storageConsent === undefined
            ? consentTime === undefined
              ? {}
              : { consentTime }
            : { storageConsent }),
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
