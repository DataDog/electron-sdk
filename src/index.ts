import { Assembly, createFormatHooks, registerCommonContext } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/SessionManager';
import { EventManager, EventKind, LifecycleKind } from './event';
import { startTelemetry, callMonitored } from './domain/telemetry';
import type { ErrorOptions } from './domain/rum';
import { Transport } from './transport';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;
let transport: Transport | undefined;
let rumApi: ReturnType<RumCollection['getApi']> | undefined;

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

  transport = await Transport.create(config, eventManager);
  const rum = new RumCollection(eventManager, hooks);

  rumApi = rum.getApi();

  return true;
}

/**
 * Stop the current session
 */
export function stopSession(): void {
  callMonitored(() => sessionManager?.expire());
}

/**
 * Report a manually handled error
 */
export function addError(error: unknown, options?: ErrorOptions): void {
  callMonitored(() => rumApi?.addError(error, options));
}

/**
 * Internal API to simulate end-user activity
 * TODO(RUM-14303) replace usages with real user activity
 */
export function _generateActivity(): void {
  callMonitored(() => eventManager?.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.END_USER_ACTIVITY }));
}

/*
 * Internal API to test monitoring
 * TODO replace with the usage of another API when available
 */

/**
 * Internal API to flush all pending batches to the intake
 */
export async function _flushTransport(): Promise<void> {
  await transport?.flush();
}

export function _generateTelemetryError() {
  return callMonitored(() => {
    throw new Error('expected error');
  });
}

export type { InitConfiguration } from './config';
export type { RumErrorEvent, RumViewEvent } from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';
