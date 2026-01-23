import type { RumViewEvent } from '../rumEvent.types';
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
