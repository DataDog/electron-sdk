import type { RumViewEvent } from '../rumEvent.types';

export function computeIntakeUrl(proxy: string): string {
  return proxy;
}

export async function sendEvent(event: RumViewEvent, intakeUrl: string, clientToken: string): Promise<void> {
  const response = await fetch(intakeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'DD-API-KEY': clientToken,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    throw new Error(`Failed to send event: HTTP ${response.status}`);
  }
}
