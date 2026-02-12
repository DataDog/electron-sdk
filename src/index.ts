import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { Transport } from './transport/http';
import { DummyMainView } from './domain/rum/rum';
import { SessionManager } from './domain/sessionManager';
import { EventManager } from './event';
import { Assembly } from './domain/assembly';
import { createFormatHooks } from './domain/hooks';
import { startTelemetry, callMonitored } from './domain/telemetry/telemetry';

export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  const eventManager = new EventManager();
  const hooks = createFormatHooks();

  startTelemetry(eventManager, config);
  const sessionManager = await SessionManager.start(eventManager);

  new Assembly(eventManager, hooks);
  new Transport(config, eventManager);
  new DummyMainView(config, sessionManager.getSession().id, eventManager);

  return true;
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
export type * from './domain/rum/rumEvent.types';
export type * from './domain/telemetry/telemetryEvent.types';
