import { ipcMain } from 'electron';
import { EventKind, EventSource, EventFormat } from '../event';
import type { EventManager, RawRumEvent } from '../event';

const BRIDGE_CHANNEL = 'datadog:bridge-send';
const CONFIG_CHANNEL = 'datadog:bridge-config';

interface BridgeEvent {
  eventType: 'rum' | 'log';
  event: unknown;
}

export interface BridgeOptions {
  privacyLevel: string;
  allowedWebViewHosts: string[];
}

export class BridgeHandler {
  constructor(
    private readonly eventManager: EventManager,
    private readonly bridgeOptions: BridgeOptions
  ) {
    ipcMain.on(BRIDGE_CHANNEL, (_ipcEvent, msg: string) => {
      this.onBridgeMessage(msg);
    });

    ipcMain.on(CONFIG_CHANNEL, (event) => {
      event.returnValue = this.bridgeOptions;
    });
  }

  private onBridgeMessage(msg: string): void {
    let bridgeEvent: BridgeEvent;
    try {
      bridgeEvent = JSON.parse(msg) as BridgeEvent;
    } catch {
      console.warn('[dd-electron] Failed to parse bridge message:', msg);
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
      case 'log':
        // TODO(RUM-15047)
        break;
      default:
        console.warn('[dd-electron] Unhandled bridge event type:', bridgeEvent.eventType);
    }
  }
}
