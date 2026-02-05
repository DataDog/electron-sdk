import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { Transport } from './transport/http';
import { DummyMainView } from './domain/rum/rum';
import { Observable } from '@datadog/browser-core';
import { SessionManager } from './domain/sessionManager';
import { EventManager } from './event/EventManager';
import { Assembly } from './domain/assembly';

export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  const eventManager = new EventManager();

  // TODO(RUM-14303): track and notify user activity
  const activityObservable = new Observable<void>();
  const sessionManager = await SessionManager.start(activityObservable);

  new Assembly(eventManager);
  new Transport(config, eventManager);
  new DummyMainView(config, sessionManager.getSession().id, eventManager);

  return true;
}

export type { InitConfiguration } from './config';
export type * from './domain/rum/rumEvent.types';
