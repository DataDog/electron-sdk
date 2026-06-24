import { ipcMain } from 'electron';
import { type TimeStamp } from '@datadog/js-core/time';
import { combine } from '@datadog/js-core/util';
import { DISCARDED } from '@datadog/js-core/assembly';
import type { DefaultPrivacyLevel } from '@datadog/browser-core';
import { EventKind, EventSource, EventTrack, LifecycleKind } from '../event';
import type { EventManager, ServerRumEvent } from '../event';
import { monitor, addError as addTelemetryError } from '../domain/telemetry';
import { BRIDGE_CHANNEL, CONFIG_CHANNEL } from '../common';
import type { FormatHooks } from './hooks';
import type { RumEvent } from '../domain/rum';

export interface BridgeOptions {
  defaultPrivacyLevel: DefaultPrivacyLevel;
  allowedWebViewHosts: string[];
}

type BridgeEventType = 'rum' | 'log' | 'internal_telemetry';

interface BridgeEvent {
  eventType: BridgeEventType;
  event: unknown;
}

/**
 * Owns the renderer-to-main IPC channel and enriches all renderer-originated events.
 *
 * Receives pre-assembled events from the browser RUM SDK via the DatadogEventBridge,
 * injects main-process context (session.id, application.id, container.view.id) via
 * triggerRum with source RENDERER, and emits ServerEvents directly.
 *
 * Also emits END_USER_ACTIVITY for click actions before the session check, so a click
 * after session inactivity expiry can create a new session even though the event itself
 * would be discarded (its timestamp falls outside the closed session window).
 */
export class RendererPipeline {
  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    private readonly bridgeOptions: BridgeOptions
  ) {
    ipcMain.on(
      BRIDGE_CHANNEL,
      monitor((_ipcEvent: unknown, msg: string) => {
        this.onBridgeMessage(msg);
      })
    );

    ipcMain.on(
      CONFIG_CHANNEL,
      monitor((event: { returnValue: unknown }) => {
        event.returnValue = this.bridgeOptions;
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
        this.handleRumEvent(bridgeEvent.event);
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

  private handleRumEvent(eventData: unknown): void {
    const data = eventData as RumEvent;

    // Emit activity before the session check: a click after session expiry must still
    // create a new session even though triggerRum will return DISCARDED
    // (the event timestamp falls outside the now-closed session window).
    if (data.type === 'action' && data.action.type === 'click') {
      this.eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
    }

    const hookResult = this.hooks.triggerRum({
      eventType: data.type,
      startTime: data.date as TimeStamp,
      source: EventSource.RENDERER,
    });

    if (hookResult === DISCARDED) {
      return;
    }

    const serverEvent: ServerRumEvent = {
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      source: EventSource.RENDERER,
      data: combine(data, hookResult ?? {}),
    };

    this.eventManager.notify(serverEvent);
  }
}
