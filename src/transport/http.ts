import { EventManager, EventKind, type ServerEvent } from '../event';
import { Configuration } from '../config';
import { displayError } from '../tools/display';

export class Transport {
  constructor(
    private config: Configuration,
    private eventManager: EventManager
  ) {
    this.eventManager.registerHandler<ServerEvent>({
      canHandle: (event) => event.kind === EventKind.SERVER,
      handle: (event) => {
        sendEvent(this.config, event).catch((error) => {
          displayError('Failed to send event:', error);
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
