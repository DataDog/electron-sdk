import { Assembly, createFormatHooks, registerCommonContext } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/session';
import { UserActivityTracker } from './domain/UserActivityTracker';
import type { ErrorOptions } from './domain/rum';
import { callMonitored, startTelemetry } from './domain/telemetry';
import { EventManager } from './event';
import { BridgeHandler } from './bridge';
import { Transport } from './transport';
import { Tracing } from './domain/tracing/Tracing';
import { ResourceConverter } from './domain/tracing/ResourceConverter';
import { displayInfo } from './tools/display';

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

  // Preload injection is handled by @datadog/electron-sdk/init which hooks
  // require('electron') and wraps BrowserWindow before the app imports electron.
  // registerPreload();

  const tracing = new Tracing();

  eventManager = new EventManager();
  const hooks = createFormatHooks();

  registerCommonContext(config, hooks);
  startTelemetry(eventManager, config);
  sessionManager = await SessionManager.start(eventManager, hooks);

  new Assembly(eventManager, hooks);
  new BridgeHandler(eventManager, config);
  new UserActivityTracker(eventManager);

  if (tracing.enabled) {
    new ResourceConverter(eventManager, hooks, config.env ?? '');
    displayInfo('Tracing enabled');
  }

  transport = await Transport.create(config, eventManager);
  const rum = await RumCollection.start(eventManager, hooks);
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
 * Internal API to flush all pending batches to the intake
 */
export async function _flushTransport(): Promise<void> {
  await transport?.flush();
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
export type { RumErrorEvent, RumViewEvent } from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';

export { SESSION_TIME_OUT_DELAY } from './domain/session';
