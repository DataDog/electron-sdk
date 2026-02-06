import type { RumViewEvent } from '../rumEvent.types';
import type { Event, EventHandler, ServerEvent } from '../event/types';
import { EventKind } from '../event/constants';
import { Configuration } from '../config';

export async function sendEvent(config: Configuration, event: RumViewEvent): Promise<void> {
  const response = await fetch(config.intakeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': config.clientToken,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`Failed to send event: HTTP ${response.status}`);
  }
}

export function createTransportHandler(config: Configuration): EventHandler<Event> {
  return {
    canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
    handle: (event) => {
      const serverEvent = event as ServerEvent;
      sendEvent(config, serverEvent.data as RumViewEvent).catch((error) => {
        console.error('Failed to send event:', error);
      });
    },
  };
}
