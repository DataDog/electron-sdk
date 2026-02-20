import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { Transport } from './transport/http';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/sessionManager';
import { EventManager, EventKind, LifecycleKind } from './event';
import { Assembly, registerCommonContext, createFormatHooks } from './assembly';
import { startTelemetry, callMonitored } from './domain/telemetry';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;

/**
 * Initialize the Electron SDK
 */
export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  eventManager = new EventManager();
  const hooks = createFormatHooks();

  registerCommonContext(config, hooks);
  startTelemetry(eventManager, config);
  sessionManager = await SessionManager.start(eventManager, hooks);

  new Assembly(eventManager, hooks);
  new Transport(config, eventManager);
  new RumCollection(eventManager, hooks);

  return true;
}

/**
 * Stop the current session
 */
export function stopSession(): void {
  sessionManager?.expire();
}

/**
 * Internal API to simulate end-user activity
 * TODO(RUM-14303) replace usages with real user activity
 */
export function _generateActivity(): void {
  eventManager?.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY });
}

/*
 * Internal API to test monitoring
 * TODO replace with the usage of another API when available
 */
export function _generateTelemetryError() {
  return callMonitored(() => {
    throw new Error('expected error');
  });
}

export type { InitConfiguration } from './config';
export type { RumViewEvent } from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';
