import { test, expect } from '../lib/helpers';
import type { TelemetryErrorEvent } from '@datadog/electron-sdk';

test('new session id is generated when renewing a session', async ({ app, intake }) => {
  await app.generateTelemetryError();

  const firstEvents = await intake.getEventsByType('telemetry');
  const firstSessionId = (firstEvents[0].body as TelemetryErrorEvent).session?.id;
  expect(firstSessionId).toMatch(/^[0-9a-f-]+$/);

  await app.renewSession();
  await app.generateTelemetryError();

  const allEvents = await intake.waitForEventCount('telemetry', 2);
  const secondSessionId = (allEvents[1].body as TelemetryErrorEvent).session?.id;
  expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);

  expect(secondSessionId).not.toBe(firstSessionId);
});
