import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { Transport } from './transport/http';
import { DummyMainView } from './domain/rum';
import { Observable } from '@datadog/browser-core';
import { SessionManager } from './domain/sessionManager';
import { EventManager } from './event/EventManager';
import type { Event } from './event/types';
import { Assembly } from './domain/assembly';

export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  const eventManager = new EventManager<Event>();

  // TODO(RUM-14303): track and notify user activity
  const activityObservable = new Observable<void>();
  const sessionManager = await SessionManager.start(activityObservable);

  new DummyMainView(config, sessionManager.getSession().id, eventManager);
  new Assembly(eventManager);
  new Transport(config, eventManager);

  return true;
}

export type { InitConfiguration } from './config';
export type * from './rumEvent.types';
