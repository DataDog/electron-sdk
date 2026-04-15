import { ipcMain, type IpcMainEvent } from 'electron';
import { DefaultPrivacyLevel } from '@datadog/browser-core';
import { EventKind, EventSource, EventFormat } from '../event';
import type { EventManager, RawRumEvent } from '../event';
import { monitor, addError as addTelemetryError } from '../domain/telemetry';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';

type BridgeEventType = 'rum' | 'log' | 'internal_telemetry';

interface BridgeEvent {
  eventType: BridgeEventType;
  event: unknown;
}

export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
}

/**
 * Receives events from renderer processes via IPC and routes them through the
 * main-process EventManager pipeline.
 *
 * The preload script (`src/preload/bridge.ts`) exposes a `DatadogEventBridge`
 * to each renderer. When the browser RUM SDK sends an event through the bridge,
 * it arrives here as a JSON string and is forwarded as a `RawRumEvent` (or, in
 * the future, a log / telemetry event) to the existing assembly & transport
 * chain.
 */
export class BridgeHandler {
  constructor(
    private readonly eventManager: EventManager,
    private readonly bridgeOptions: BridgeOptions
  ) {
    ipcMain.on(
      BRIDGE_CHANNEL,
      monitor((ipcEvent: IpcMainEvent, msg: string) => {
        const senderPid = ipcEvent.sender?.getOSProcessId();
        this.onBridgeMessage(msg, senderPid);
      })
    );

    ipcMain.on(
      CONFIG_CHANNEL,
      monitor((event: { returnValue: unknown }) => {
        event.returnValue = this.bridgeOptions;
      })
    );
  }

  private onBridgeMessage(msg: string, senderPid?: number): void {
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
          senderPid,
        } as RawRumEvent);
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
