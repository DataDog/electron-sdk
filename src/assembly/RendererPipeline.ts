import { ipcMain, type IpcMainEvent } from 'electron';
import { type TimeStamp } from '@datadog/js-core/time';
import { combine, isIndexableObject, type RecursivePartial } from '@datadog/js-core/util';
import { DISCARDED } from '@datadog/js-core/assembly';
import { EventKind, EventSource, EventTrack, LifecycleKind, EventFormat } from '../event';
import type { EventManager, ServerRumEvent, BrowserProfileEvent, BrowserProfilerTrace } from '../event';
import { isEmptyObject } from '@datadog/browser-core';
import { monitor, addError as addTelemetryError } from '../domain/telemetry';
import { BRIDGE_CHANNEL, setBridgeConfig, type BridgeOptions } from '../common';
import type { FormatHooks } from './hooks';
import type { RumEvent } from '../domain/rum';
import { Configuration } from '../config';

type BridgeEventType = 'rum' | 'log' | 'internal_telemetry' | 'profile';

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
      capabilities: config.profilingSampleRate > 0 ? ['profiles'] : [],
    };

    ipcMain.on(
      BRIDGE_CHANNEL,
      monitor((ipcEvent: IpcMainEvent, msg: string) => {
        if (!isAllowedOrigin(ipcEvent.senderFrame?.origin, this.bridgeOptions.allowedRendererHosts)) {
          return;
        }
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
      addTelemetryError(new Error(`Failed to parse bridge message: ${msg}`));
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
        // TODO(RUM-15253)
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

    const overrides = resolveCustomerContextOverrides(data, hookResult);

    const serverEvent: ServerRumEvent = {
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      source: EventSource.RENDERER,
      data: combine(data, overrides),
    };

    this.eventManager.notify(serverEvent);
  }
}

/**
 * The renderer's own user/account context takes precedence. An anonymous-only renderer user
 * is the exception: preserve its anonymous_id while enriching it with the main-process user.
 * session/application/container always come from the main process.
 */
function resolveCustomerContextOverrides(
  data: RumEvent,
  hookResult: RecursivePartial<RumEvent> | null | undefined
): RecursivePartial<RumEvent> {
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
function isAnonymousOnlyUserContext(context: RumEvent['usr']): boolean {
  if (context === undefined) return false;
  const keys = Object.keys(context);
  return keys.length > 0 && keys.every((key) => key === 'anonymous_id');
}

/**
 * Mirrors the Browser SDK's matchesHostEntry logic so both layers enforce the same rules.
 * Supports exact match, subdomain suffix (e.g. 'example.com' matches 'sub.example.com'),
 * and single-wildcard glob patterns (e.g. 'preview-*.example.com').
 */
function matchesRendererHostEntry(host: string, entry: string): boolean {
  if (!entry.includes('*')) return host === entry || host.endsWith(`.${entry}`);
  const parts = entry.split('*');
  if (parts.length !== 2) return false;
  const [prefix, suffix] = parts;
  return host.length > prefix.length + suffix.length && host.startsWith(prefix) && host.endsWith(suffix);
}

function isAllowedOrigin(origin: string | undefined, allowedRendererHosts: string[]): boolean {
  if (!origin) return false;
  if (allowedRendererHosts.includes('*')) return true;
  // file:// origin has no hostname; normalize to '' to match the stored value
  if (origin === 'file://') return allowedRendererHosts.includes('');
  try {
    const hostname = new URL(origin).hostname;
    return allowedRendererHosts.some((entry) => matchesRendererHostEntry(hostname, entry));
  } catch {
    return false;
  }
}
