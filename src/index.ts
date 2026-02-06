import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { createTransportHandler } from './transport/http';
import { createDummyViewEvent, createServerEventHandler } from './domain/rum';
import { Observable } from '@datadog/browser-core';
import { SessionManager } from './domain/sessionManager';
import { EventManager } from './event/EventManager';
import type { Event, RawEvent } from './event/types';
import { EventKind, EventSource } from './event/constants';

export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  // TODO(RUM-14303): track and notify user activity
  const activityObservable = new Observable<void>();
  const sessionManager = await SessionManager.start(activityObservable);

  const eventManager = new EventManager<Event>();
  eventManager.registerHandler(createServerEventHandler());
  eventManager.registerHandler(createTransportHandler(config));

  const viewEvent = createDummyViewEvent(config, sessionManager.getSession().id);
  const rawEvent: RawEvent = {
    kind: EventKind.RAW,
    source: EventSource.MAIN,
    data: viewEvent,
  };

  eventManager.notify(rawEvent);

  return true;
}

export type { InitConfiguration } from './config';
export type * from './rumEvent.types';
