import type { InitConfiguration } from './types';
import { computeIntakeUrl, sendEvent } from './transport/http';
import { createDummyViewEvent } from './domain/rum';

export function init(configuration: InitConfiguration): boolean {
  try {
    const intakeUrl = computeIntakeUrl(configuration.proxy);

    const viewEvent = createDummyViewEvent(configuration);

    sendEvent(viewEvent, intakeUrl, configuration.clientToken).catch((error) => {
      console.error('Failed to send RUM view event:', error);
    });

    return true;
  } catch (error) {
    console.error('SDK initialization failed:', error);
    return false;
  }
}

export type { InitConfiguration } from './types';
export type * from './rumEvent.types';
