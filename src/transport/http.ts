import type { ServerEvent, Event } from '../event/types';
import { EventKind } from '../event/constants';
import { Configuration } from '../config';
import { EventManager } from '../event/EventManager';

export class Transport {
  constructor(
    private config: Configuration,
    private eventManager: EventManager<Event>
  ) {
    this.eventManager.registerHandler({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => {
        sendEvent(this.config, event as ServerEvent).catch((error) => {
          console.error('Failed to send event:', error);
        });
      },
    });
  }
}

export async function sendEvent(config: Configuration, event: ServerEvent): Promise<void> {
  const response = await fetch(config.intakeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': config.clientToken,
    },
    body: JSON.stringify(event.data),
  });

  if (!response.ok) {
    throw new Error(`Failed to send event: HTTP ${response.status}`);
  }
}
