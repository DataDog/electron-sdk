import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { sendEvent } from './transport/http';
import { createDummyViewEvent } from './domain/rum';
import { Observable } from '@datadog/browser-core';
import { startSessionManager } from './domain/sessionManager';

export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  // TODO(RUM-14303): track and notify user activity
  const activityObservable = new Observable<void>();
  const sessionManager = await startSessionManager(activityObservable);

  const viewEvent = createDummyViewEvent(config, sessionManager.getSession().id);

  sendEvent(config, viewEvent).catch((error) => {
    console.error('Failed to send RUM view event:', error);
  });

  return true;
}

export type { InitConfiguration } from './config';
export type * from './rumEvent.types';
