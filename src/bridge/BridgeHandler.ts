import { DefaultPrivacyLevel } from '@datadog/browser-core';
import { ipcMain } from 'electron';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';
import type { BrowserRecord } from '../domain/replay';
import { addError as addTelemetryError, monitor } from '../domain/telemetry';
import type { EventManager, RawRumEvent } from '../event';
import { EventFormat, EventKind, EventSource } from '../event';

type BridgeEventType = 'rum' | 'log' | 'internal_telemetry' | 'record';

interface BridgeEvent {
  eventType: BridgeEventType;
  event: unknown;
  view?: { id: string };
}

export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
}

/**
 * Receives events from renderer processes via IPC and routes them through the
 * main-process EventManager pipeline.
 *
 * dd-trace's preload script exposes a `DatadogEventBridge` to each renderer.
 * When the browser RUM SDK sends an event through the bridge, it arrives here
 * as a JSON string and is forwarded as a {@link RawRumEvent} (RUM, telemetry)
 * or {@link RawReplayEvent} (session replay records) into the EventManager pipeline.
 * Also handles async {@link CONFIG_CHANNEL} requests from the preload to supply
 * bridge configuration (privacy level, allowed hosts).
 */
export class BridgeHandler {
  constructor(
    private readonly eventManager: EventManager,
    private readonly bridgeOptions: BridgeOptions
  ) {
    ipcMain.on(
      BRIDGE_CHANNEL,
      monitor((_ipcEvent: unknown, msg: string) => {
        this.onBridgeMessage(msg);
      })
    );

    ipcMain.handle(
      CONFIG_CHANNEL,
      monitor(() => {
        return this.bridgeOptions;
      })
    );
  }

  private onBridgeMessage(msg: string): void {
    let bridgeEvent: BridgeEvent;

    try {
      bridgeEvent = JSON.parse(msg) as BridgeEvent;
    } catch {
      addTelemetryError(new Error(`Failed to parse bridge message: ${msg}`));
      return;
    }

    switch (bridgeEvent.eventType) {
      case 'rum':
        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.RENDERER,
          format: EventFormat.RUM,
          data: bridgeEvent.event,
        } as RawRumEvent);
        break;

      case 'record':
        if (!bridgeEvent.view) {
          addTelemetryError(new Error('Replay record missing view'));
          break;
        }
        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.RENDERER,
          format: EventFormat.REPLAY,
          data: bridgeEvent.event as BrowserRecord,
          view: bridgeEvent.view,
        });
        break;

      case 'log':
        // TODO(RUM-15047)
        break;

      case 'internal_telemetry':
        // TODO(RUM-15253)
        break;

      default:
        addTelemetryError(new Error(`Unhandled bridge event type: ${String(bridgeEvent.eventType)}`));
    }
  }
}
