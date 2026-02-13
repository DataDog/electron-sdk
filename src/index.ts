import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { Transport } from './transport/http';
import { DummyMainView } from './domain/rum';
import { SessionManager } from './domain/sessionManager';
import { EventManager } from './event';
import { Assembly } from './domain/assembly';
import { registerCommonContext } from './domain/commonContext';
import { createFormatHooks } from './domain/hooks';
import { startTelemetry, callMonitored } from './domain/telemetry';

export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  const eventManager = new EventManager();
  const hooks = createFormatHooks();

  registerCommonContext(config, hooks);
  startTelemetry(eventManager, config);
  await SessionManager.start(eventManager, hooks);

  new Assembly(eventManager, hooks);
  new Transport(config, eventManager);
  new DummyMainView(eventManager);

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
export type { RumViewEvent } from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';
