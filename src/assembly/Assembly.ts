import { combine, DISCARDED, timeStampNow, type RecursivePartial, TimeStamp } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource, EventTrack, type RawEvent, ServerEvent } from '../event';
import type { RawRumEvent } from '../event';
import type { FormatHooks } from './hooks';
import { RumEvent } from '../domain/rum';
import { TelemetryEvent } from '../domain/telemetry';

/**
 * Transforms RawEvents into ServerEvents by enriching them with contextual
 * attributes (session, application, view, etc.) via format hooks.
 *
 * Handles two sources differently:
 * - **Main-process events**: fully assembled by combining raw data with all
 *   registered hook results (commonContext, session, view).
 * - **Renderer events**: arrive pre-assembled by `@datadog/browser-rum` in
 *   the renderer process. Main-process hooks receive the event source and
 *   renderer view ID so they can inject additional attributes (e.g. replay
 *   stats). Only the hook results are applied; the renderer's own view,
 *   source, service, and other attributes are preserved.
 */
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

  /** Route to the appropriate assembly strategy based on event source. */
  private assembleToServerEvent(event: RawEvent): ServerEvent | DISCARDED {
    // Replay events are handled by ReplayCollection, not Assembly
    if (event.format === EventFormat.REPLAY) {
      return DISCARDED;
    }

    if (event.format === EventFormat.RUM && event.source === EventSource.RENDERER) {
      return this.assembleRendererRumEvent(event);
    }

    return this.assembleMainProcessEvent(event);
  }

  /**
   * Renderer RUM events arrive already assembled by `@datadog/browser-rum`.
   * Hooks receive the event source and renderer view ID so they can contribute
   * additional attributes (e.g. replay stats). Only targeted fields from the
   * hook results are applied; the renderer's own source, service, view, and
   * other attributes are preserved.
   */
  private assembleRendererRumEvent(event: RawRumEvent): ServerEvent | DISCARDED {
    const rendererViewId = (event.data as { view?: { id?: string } }).view?.id;

    const hookResult = this.hooks.triggerRum({
      eventType: event.data.type,
      startTime: event.data.date as TimeStamp,
      source: EventSource.RENDERER,
      rendererViewId,
    });

    if (hookResult === DISCARDED) {
      return DISCARDED;
    }

    const { session, application, view, _dd } = hookResult ?? {};

    const mainProcessAttributes = {
      session,
      application: { id: application?.id },
      container: { view: { id: view?.id }, source: 'electron' },
      ...(_dd ? { _dd } : {}),
    };

    return {
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      source: EventSource.RENDERER,
      // override some renderer event attributes by main process attributes
      data: combine(event.data, mainProcessAttributes) as RumEvent,
    };
  }

  /**
   * Main-process events are assembled by combining raw data with the full
   * hook chain (commonContext, session, view), producing a complete
   * ServerEvent ready for transport.
   */
  private assembleMainProcessEvent(event: RawEvent): ServerEvent | DISCARDED {
    const startTime = event.startTime ?? timeStampNow();

    if (event.format === EventFormat.RUM) {
      const hookResult = this.hooks.triggerRum({
        eventType: event.data.type,
        startTime,
        source: EventSource.MAIN,
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
