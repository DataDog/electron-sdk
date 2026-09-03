import { ipcMain, type IpcMainEvent } from 'electron';
import { type TimeStamp } from '@datadog/js-core/time';
import { combine, isIndexableObject, type RecursivePartial } from '@datadog/js-core/util';
import { DISCARDED } from '@datadog/js-core/assembly';
import { EventKind, EventSource, EventTrack, LifecycleKind, EventFormat } from '../event';
import type {
  EventManager,
  ServerRumEvent,
  ServerTelemetryEvent,
  BrowserProfileEvent,
  BrowserProfilerTrace,
  RawReplayEvent,
} from '../event';
import { isEmptyObject } from '@datadog/browser-core';
import { monitor, addError as addTelemetryError, type TelemetryEvent } from '../domain/telemetry';
import { BRIDGE_CHANNEL, setBridgeConfig, type BridgeOptions } from '../common';
import type { FormatHooks } from './hooks';
import type { RendererRumEvent } from '../domain/rum';
import { Configuration } from '../config';
import { isFiniteNumber } from '../tools/validation';
import { RendererIpcGate } from './RendererIpcGate';

type BridgeEventType = 'rum' | 'log' | 'internal_telemetry' | 'profile' | 'record';

interface BridgeEvent {
  eventType: BridgeEventType;
  event: unknown;
  view?: { id: string };
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
  private readonly bridgeOptions: BridgeOptions;

  constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks,
    config: Configuration
  ) {
    this.bridgeOptions = {
      defaultPrivacyLevel: config.defaultPrivacyLevel,
      allowedRendererHosts: config.allowedRendererHosts,
      // Capabilities are resolved once here and advertised globally, not per session. Bridge mode has no
      // channel to notify the renderer on session renew/expire or capability changes, so the browser SDK
      // cannot adjust its per-session behavior (e.g. stop profiling a sampled-out session). Out of scope for now.
      capabilities: [
        ...(config.profilingSampleRate > 0 ? ['profiles'] : []),
        ...(config.sessionReplaySampleRate > 0 ? ['records'] : []),
      ],
    };

    const gate = new RendererIpcGate(this.bridgeOptions.allowedRendererHosts);

    ipcMain.on(
      BRIDGE_CHANNEL,
      monitor((ipcEvent: IpcMainEvent, msg: string) => {
        if (!gate.isAllowed(ipcEvent)) return;
        this.onBridgeMessage(msg);
      })
    );

    // The CONFIG_CHANNEL responder is registered at instrument time; here we publish the real config
    // so it replaces the fallback returned for windows loaded before init().
    setBridgeConfig(this.bridgeOptions);
  }

  private onBridgeMessage(msg: string): void {
    let bridgeEvent: BridgeEvent;
    try {
      bridgeEvent = JSON.parse(msg) as BridgeEvent;
    } catch {
      addTelemetryError(new Error('Failed to parse bridge message'));
      return;
    }

    switch (bridgeEvent.eventType) {
      case 'rum':
        this.handleRumEvent(bridgeEvent.event);
        break;
      case 'log':
        // TODO(RUM-15047): when Logs are implemented, enrich them with user/account context
        // matching mobile: `usr.*` and `account.*`.
        break;
      case 'internal_telemetry':
        this.handleTelemetryEvent(bridgeEvent.event);
        break;
      case 'profile': {
        const payload = bridgeEvent.event as { profile?: BrowserProfileEvent; trace?: BrowserProfilerTrace };
        // Validate the renderer-supplied shape early: a malformed message without a profile/trace would
        // otherwise fail later at serialization/upload with no useful context.
        if (!isIndexableObject(payload?.profile) || !isIndexableObject(payload?.trace)) {
          addTelemetryError(new Error('Received malformed profile bridge event'));
          return;
        }
        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.RENDERER,
          format: EventFormat.PROFILE,
          data: payload.profile,
          trace: payload.trace,
        });
        break;
      }
      case 'record': {
        // view.id is untrusted IPC input and keys the segment metadata/stats: require a non-empty
        // *string*. A truthy non-string (e.g. 123) would otherwise become the segment's view id and
        // no longer match the string RUM view id, breaking stitching / losing replay stats.
        const viewId = (bridgeEvent.view as { id?: unknown } | undefined)?.id;
        if (typeof viewId !== 'string' || viewId.length === 0) {
          addTelemetryError(new Error('Replay record missing view'));
          break;
        }
        // Validate the renderer-supplied shape early: a malformed record would otherwise fail
        // later at segment serialization/upload with no useful context.
        if (!isIndexableObject(bridgeEvent.event)) {
          addTelemetryError(new Error('Received malformed replay record'));
          break;
        }
        // A bridge/SDK version mismatch can send an object that lacks a numeric timestamp/type.
        // Segment.addRecord derives start/end from timestamp via Math.min/Math.max, so a missing
        // or non-finite value turns segment metadata into NaN (serialized as null) and makes the
        // uploaded segment unusable. Reject at the boundary instead, matching the profile validation.
        if (!isFiniteNumber(bridgeEvent.event.timestamp) || !isFiniteNumber(bridgeEvent.event.type)) {
          addTelemetryError(new Error('Received replay record with invalid timestamp or type'));
          break;
        }
        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.RENDERER,
          format: EventFormat.REPLAY,
          data: bridgeEvent.event,
          view: { id: viewId },
        } as RawReplayEvent);
        break;
      }
      default:
        addTelemetryError(new Error(`Unhandled bridge event type: ${String(bridgeEvent.eventType)}`));
    }
  }

  private handleRumEvent(eventData: unknown): void {
    const data = eventData as RendererRumEvent;

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
      rendererViewId: (data as { view?: { id?: string } }).view?.id,
    });

    if (hookResult === DISCARDED) {
      return;
    }

    this.emitRendererEvent(data, resolveCustomerContextOverrides(data, hookResult));
  }

  /**
   * Forwards a telemetry event the renderer's browser RUM SDK has already assembled.
   *
   * It is not re-sampled or deduplicated because the browser SDK has already applied its telemetry
   * configuration before sending the event over the bridge.
   */
  private handleTelemetryEvent(eventData: unknown): void {
    // Validate the bridge payload without restricting renderer-owned fields or telemetry kinds,
    // which may evolve independently in the browser SDK.
    if (
      !isIndexableObject(eventData) ||
      eventData.type !== 'telemetry' ||
      !isFiniteNumber(eventData.date) ||
      !isIndexableObject(eventData.telemetry) ||
      (typeof eventData.telemetry.type !== 'string' && typeof eventData.telemetry.status !== 'string')
    ) {
      addTelemetryError(new Error('Received malformed telemetry bridge event'));
      return;
    }

    const data = { ...eventData } as unknown as TelemetryEvent;
    // The browser SDK creates a stub session in bridge mode. Only keep the main-process session
    // that the telemetry hooks add when one covers the event date.
    delete data.session;

    const hookResult = this.hooks.triggerTelemetry({
      startTime: data.date as TimeStamp,
      source: EventSource.RENDERER,
    });

    if (hookResult === DISCARDED) {
      return;
    }

    this.emitRendererEvent(data, hookResult);
  }

  /**
   * Emits an event a renderer's browser SDK already assembled, enriched with what the main process
   * owns.
   *
   * Overrides are merged last, so the application and session the main process owns win over the ones
   * the renderer reported. Everything else stays the renderer's, see `registerCommonContext`.
   */
  private emitRendererEvent<E extends RumEvent | TelemetryEvent>(
    data: E,
    overrides: RecursivePartial<E> | undefined
  ): void {
    this.eventManager.notify({
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      source: EventSource.RENDERER,
      data: combine(data, overrides),
    } as ServerRumEvent | ServerTelemetryEvent);
  }
}

/**
 * The renderer's own user/account context takes precedence. An anonymous-only renderer user
 * is the exception: preserve its anonymous_id while enriching it with the main-process user.
 * session/application/container always come from the main process.
 */
function resolveCustomerContextOverrides(
  data: RendererRumEvent,
  hookResult: RecursivePartial<RendererRumEvent> | null | undefined
): RecursivePartial<RendererRumEvent> {
  const overrides = { ...(hookResult ?? {}) };
  if (hasContext(data.usr)) {
    if (isAnonymousOnlyUserContext(data.usr) && hasContext(overrides.usr)) {
      overrides.usr = combine(overrides.usr, data.usr);
    } else {
      delete overrides.usr;
    }
  }
  if (hasContext(data.account)) delete overrides.account;
  return overrides;
}

/** Whether the renderer event already carries a non-empty context object. */
function hasContext(context: object | undefined): boolean {
  return context !== undefined && !isEmptyObject(context);
}

/** Whether the renderer carries only Browser RUM's automatically generated anonymous user id. */
function isAnonymousOnlyUserContext(context: RendererRumEvent['usr']): boolean {
  if (context === undefined) return false;
  const keys = Object.keys(context);
  return keys.length > 0 && keys.every((key) => key === 'anonymous_id');
}
