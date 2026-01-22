import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { sendEvent } from './transport/http';
import { createDummyViewEvent } from './domain/rum';

export function init(configuration: InitConfiguration): boolean {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  const viewEvent = createDummyViewEvent(config);

  sendEvent(config, viewEvent).catch((error) => {
    console.error('Failed to send RUM view event:', error);
  });

  return true;
}

export type { InitConfiguration } from './config';
export type * from './rumEvent.types';
